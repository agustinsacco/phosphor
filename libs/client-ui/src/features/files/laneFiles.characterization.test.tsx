// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { forgetRemoteSession } from '@/stores/sessions'
import {
  laneCwd,
  lanes,
  renderLaneFiles,
  resetLaneFiles,
  seedLaneFiles,
  updateHost,
} from './__fixtures__/renderLaneFiles'

// The settings store reads the colour scheme when the Files pane's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: ({
    path,
    value,
    readOnly,
    onChange,
    onSave,
  }: {
    path: string
    value: string
    readOnly?: boolean
    onChange(value: string): void
    onSave(): void
  }) => (
    <div>
      <textarea
        data-model={path}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      <button data-save={path} onClick={onSave}>
        save
      </button>
    </div>
  ),
  MonacoDiff: ({ originalText, modifiedText }: { originalText: string; modifiedText: string }) => (
    <pre>
      {originalText} → {modifiedText}
    </pre>
  ),
}))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))

afterEach(resetLaneFiles)

const workspace = lanes.a.workspacePath

/** A Host with two text files that checks revisions the way `fs.write` does. */
function fakeHost(write?: (path: string) => Promise<void> | undefined) {
  const files: Record<string, { content: string; revision: string }> = {
    'a.ts': { content: 'A text', revision: 'rev-a1' },
    'b.ts': { content: 'B text', revision: 'rev-b1' },
  }
  let next = 1
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const relative = (path: unknown) => String(path).replace(/^host:[^/]+\/lane:[^/]+\//, '')
    switch (channel) {
      case 'fs:listFiles':
        return Object.keys(files)
      case 'git:statusMap':
        return { 'a.ts': ' M' }
      case 'fs:readFile': {
        const file = files[relative(args[0])]
        if (!file) throw new Error('not-found')
        return { ...file, path: args[0], binary: false, size: file.content.length, mtimeMs: 0 }
      }
      case 'fs:writeFile': {
        await write?.(relative(args[0]))
        const file = files[relative(args[0])]
        if (!file || file.revision !== args[2]) throw new Error('changed-on-disk')
        file.content = String(args[1])
        file.revision = `rev-${++next}`
        return { mtimeMs: next, revision: file.revision }
      }
      default:
        throw new Error(`Unexpected channel ${channel}`)
    }
  }
  return { files, invoke }
}

it('lists the lane’s files and marks the ones git reports modified', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    expect(lane.files().some((row) => row.includes('a.ts'))).toBe(true)
    expect(lane.files().some((row) => row.includes('b.ts'))).toBe(true)
    expect(lane.marked('a.ts')).toBe(true)
    expect(lane.marked('b.ts')).toBe(false)
  } finally {
    lane.unmount()
  }
})

it('opens a file from the tree or a chat link, and never reads outside the lane', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    await lane.clickTreeRow('a.ts')
    expect(await lane.content('a.ts')).toBe('A text')
    await lane.openFromChat(`${laneCwd}/b.ts`)
    expect(await lane.content('b.ts')).toBe('B text')
    await lane.openFromChat('/etc/passwd')
    expect(
      lane.calls
        .filter(([channel]) => channel === 'fs:readFile')
        .every(([, path]) => String(path).startsWith(`${workspace}/`)),
    ).toBe(true)
  } finally {
    lane.unmount()
  }
})

it('saves with the revision it read, then with the one the Host returned', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    expect(await lane.edit('a.ts', 'edited')).toBe(true)
    await lane.save('a.ts')
    expect(lane.savesSent()).toEqual([['fs:writeFile', `${workspace}/a.ts`, 'edited', 'rev-a1']])
    await lane.edit('a.ts', 'edited again')
    await lane.save('a.ts')
    expect(lane.savesSent()[1]).toEqual([
      'fs:writeFile',
      `${workspace}/a.ts`,
      'edited again',
      'rev-2',
    ])
  } finally {
    lane.unmount()
  }
})

it('never replaces an edited buffer when the tree or a chat link navigates', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.clickTreeRow('b.ts')
    await lane.openFromChat('b.ts')
    await lane.clickTreeRow('a.ts')
    await lane.openFromChat('a.ts')
    await lane.openFromChat(`${laneCwd}/a.ts`)
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.save('a.ts')
    expect(lane.savesSent()).toEqual([['fs:writeFile', `${workspace}/a.ts`, 'edited', 'rev-a1']])
  } finally {
    lane.unmount()
  }
})

it('a remounted pane observes a pending save and never resends it', async () => {
  let settle: (() => void) | undefined
  const host = fakeHost(() => new Promise<void>((resolve) => (settle = resolve)))
  const lane = await renderLaneFiles({ invoke: host.invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.save('a.ts')
    await lane.remount()
    await lane.save('a.ts')
    await lane.show('b')
    await lane.show('a')
    await lane.save('a.ts')
    expect(lane.savesSent()).toHaveLength(1)
    await act(async () => settle?.())
    expect(host.files['a.ts']!.content).toBe('edited')
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.edit('a.ts', 'next')
    await lane.save('a.ts')
    expect(lane.savesSent()[1]).toEqual(['fs:writeFile', `${workspace}/a.ts`, 'next', 'rev-2'])
  } finally {
    lane.unmount()
  }
})

it('a save that settles while the pane is closed is kept', async () => {
  let settle: (() => void) | undefined
  const host = fakeHost(() => new Promise<void>((resolve) => (settle = resolve)))
  const lane = await renderLaneFiles({ invoke: host.invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.save('a.ts')
    await lane.show(null)
    await act(async () => settle?.())
    await lane.show('a')
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.edit('a.ts', 'next')
    await lane.save('a.ts')
    expect(lane.savesSent()).toHaveLength(2)
    expect(lane.savesSent()[1]?.[3]).toBe('rev-2')
  } finally {
    lane.unmount()
  }
})

it('an uncertain save keeps the buffer and is never retried', async () => {
  const host = fakeHost(() => Promise.reject(new Error('timeout')))
  const lane = await renderLaneFiles({ invoke: host.invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.save('a.ts')
    expect(lane.text()).toContain('Do not retry an uncertain save')
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.save('a.ts')
    await lane.remount()
    await lane.save('a.ts')
    expect(await lane.content('a.ts')).toBe('edited')
    expect(lane.text()).toContain('Do not retry an uncertain save')
    expect(lane.savesSent()).toHaveLength(1)
  } finally {
    lane.unmount()
  }
})

it('a conflicting save keeps the buffer and says the file changed on disk', async () => {
  const host = fakeHost()
  const lane = await renderLaneFiles({ invoke: host.invoke })
  try {
    await lane.edit('a.ts', 'edited')
    host.files['a.ts'] = { content: 'changed on Host', revision: 'rev-host' }
    await lane.save('a.ts')
    expect(lane.savesSent()).toHaveLength(1)
    expect(lane.text()).toContain('File changed on disk')
    expect(await lane.content('a.ts')).toBe('edited')
    expect(host.files['a.ts']!.content).toBe('changed on Host')
  } finally {
    lane.unmount()
  }
})

it('refreshes on the lane’s summary and runtime epoch, never through a watcher', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    const listed = lane.count('fs:listFiles')
    expect(listed).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++)
      await act(async () =>
        updateHost((host) => ({ ...host, capabilities: [...host.capabilities] })),
      )
    await act(async () =>
      updateHost((host) => ({
        ...host,
        lanes: host.lanes.map((l) =>
          l.laneId === lanes.b.laneId ? { ...l, updatedAt: new Date(5).toISOString() } : l,
        ),
      })),
    )
    expect(lane.count('fs:listFiles')).toBe(listed)
    await act(async () =>
      updateHost((host) => ({
        ...host,
        lanes: host.lanes.map((l) =>
          l.laneId === lanes.a.laneId ? { ...l, updatedAt: new Date(1000).toISOString() } : l,
        ),
      })),
    )
    expect(lane.count('fs:listFiles')).toBe(listed + 1)
    await act(async () =>
      updateHost((host) => ({ ...host, cursor: { epoch: 'new-runtime', seq: 1 } })),
    )
    expect(lane.count('fs:listFiles')).toBe(listed + 2)
    expect(lane.count('fs:watchWorkspace')).toBe(0)
    expect(lane.count('fs:statDirs')).toBe(0)
  } finally {
    lane.unmount()
  }
})

it('a reconnect keeps the edited buffer, saves nothing meanwhile and does not re-read it', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    await lane.edit('a.ts', 'edited')
    const reads = lane.count('fs:readFile')
    await act(async () => updateHost((host) => ({ ...host, state: 'reconnecting' })))
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.save('a.ts')
    expect(lane.savesSent()).toHaveLength(0)
    await act(async () => updateHost((host) => ({ ...host, state: 'ready' })))
    expect(await lane.content('a.ts')).toBe('edited')
    expect(lane.count('fs:readFile')).toBe(reads)
    await lane.save('a.ts')
    expect(lane.savesSent()).toEqual([['fs:writeFile', `${workspace}/a.ts`, 'edited', 'rev-a1']])
  } finally {
    lane.unmount()
  }
})

it('a lane this device does not control shows its files read only and saves nothing', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke, controller: false })
  try {
    expect(await lane.content('a.ts')).toBe('A text')
    expect(await lane.edit('a.ts', 'edited')).toBe(false)
    await lane.save('a.ts')
    expect(lane.savesSent()).toHaveLength(0)
  } finally {
    lane.unmount()
  }
})

it('a Host that does not offer files says so and lists nothing', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke, capabilities: ['sessions.read'] })
  try {
    expect(lane.text()).toContain('This Host does not offer files to this device.')
    expect(lane.count('fs:listFiles')).toBe(0)
  } finally {
    lane.unmount()
  }
})

it('each lane keeps its own edits, and forgetting a lane drops them', async () => {
  const lane = await renderLaneFiles({ invoke: fakeHost().invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.show('b')
    expect(await lane.content('a.ts')).toBe('A text')
    await lane.show('a')
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.show(null)
    await act(async () => forgetRemoteSession(lanes.a.sessionId))
    seedLaneFiles({
      capabilities: ['sessions.read', 'sessions.control', 'workspaces.read', 'workspaces.write'],
      controller: true,
    })
    await lane.show('a')
    expect(await lane.content('a.ts')).toBe('A text')
    expect(lane.savesSent()).toHaveLength(0)
  } finally {
    lane.unmount()
  }
})
