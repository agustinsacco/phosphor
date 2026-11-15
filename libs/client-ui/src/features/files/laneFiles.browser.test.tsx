// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetRemoteSession, useSessionsStore } from '@/stores/sessions'
import {
  fakeLaneHost,
  laneCwd,
  lanes,
  renderLaneFiles,
  resetLaneFiles,
  seedLaneFiles,
  updateHost,
} from './__fixtures__/renderLaneFiles'

// The browser lane's Files runs the cases laneFiles.characterization pins for Desktop.

// The settings store reads the colour scheme when the Files pane's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('@/components/markdown/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-code>{code}</pre>,
}))
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
  MonacoDiff: () => null,
}))

afterEach(resetLaneFiles)

const workspace = lanes.a.workspacePath

describe.each(['phone', 'wide browser'] as const)('%s', (client) => {
  const render = (options: Omit<Parameters<typeof renderLaneFiles>[0], 'client'>) =>
    renderLaneFiles({ ...options, client })

  it('lists the lane’s files and marks the ones git reports modified', async () => {
    const lane = await render({ invoke: fakeLaneHost().invoke })
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
    const lane = await render({ invoke: fakeLaneHost().invoke })
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
    const lane = await render({ invoke: fakeLaneHost().invoke })
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

  it('never replaces an edited buffer when a chat link navigates', async () => {
    const lane = await render({ invoke: fakeLaneHost().invoke })
    try {
      await lane.edit('a.ts', 'edited')
      await lane.openFromChat('b.ts')
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
    const host = fakeLaneHost(() => new Promise<void>((resolve) => (settle = resolve)))
    const lane = await render({ invoke: host.invoke })
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
    const host = fakeLaneHost(() => new Promise<void>((resolve) => (settle = resolve)))
    const lane = await render({ invoke: host.invoke })
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
    const host = fakeLaneHost(() => Promise.reject(new Error('timeout')))
    const lane = await render({ invoke: host.invoke })
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
    const host = fakeLaneHost()
    const lane = await render({ invoke: host.invoke })
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
    const lane = await render({ invoke: fakeLaneHost().invoke })
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
    const lane = await render({ invoke: fakeLaneHost().invoke })
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
    const lane = await render({ invoke: fakeLaneHost().invoke, controller: false })
    try {
      expect(await lane.content('a.ts')).toBe('A text')
      expect(await lane.edit('a.ts', 'edited')).toBe(false)
      await lane.save('a.ts')
      expect(lane.savesSent()).toHaveLength(0)
      expect(lane.text()).toContain('Read only')
    } finally {
      lane.unmount()
    }
  })

  it('a Host that does not offer files says so and lists nothing', async () => {
    const lane = await render({ invoke: fakeLaneHost().invoke, capabilities: ['sessions.read'] })
    try {
      expect(lane.text()).toContain('This Host does not offer files to this device.')
      expect(lane.count('fs:listFiles')).toBe(0)
    } finally {
      lane.unmount()
    }
  })

  it('each lane keeps its own edits, and forgetting a lane drops them', async () => {
    const lane = await render({ invoke: fakeLaneHost().invoke })
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

  // The Host answers reads only for the focused lane, and focus follows activation.
  it('waits for its lane to become active before reading, then reads', async () => {
    const lane = await render({ invoke: fakeLaneHost().invoke, inactive: true })
    try {
      expect(lane.calls).toEqual([])
      expect(lane.text()).not.toContain('could')
      await act(async () => useSessionsStore.setState({ activeSessionId: lanes.a.sessionId }))
      expect(lane.count('fs:listFiles')).toBe(1)
      expect(lane.files().some((row) => row.includes('a.ts'))).toBe(true)
    } finally {
      lane.unmount()
    }
  })
})

it('wide browser: the tree stays beside an edited file, which tree navigation never replaces', async () => {
  const lane = await renderLaneFiles({ invoke: fakeLaneHost().invoke, client: 'wide browser' })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.clickTreeRow('b.ts')
    await lane.clickTreeRow('a.ts')
    expect(await lane.content('a.ts')).toBe('edited')
    expect(lane.savesSent()).toHaveLength(0)
  } finally {
    lane.unmount()
  }
})

it('phone: Back to the tree closes the file, asking first when it has edits', async () => {
  const lane = await renderLaneFiles({ invoke: fakeLaneHost().invoke, client: 'phone' })
  try {
    await lane.edit('a.ts', 'edited')
    // Dismissing the dialog keeps the file and its edits on screen.
    await lane.back()
    expect(await lane.content('a.ts')).toBe('edited')
    await lane.back('save')
    expect(lane.savesSent()).toEqual([['fs:writeFile', `${workspace}/a.ts`, 'edited', 'rev-a1']])
    expect(lane.text()).not.toContain('← Files')
    // A file without edits closes at once; the tree keeps its place.
    await lane.clickTreeRow('b.ts')
    await lane.back()
    expect(lane.files().some((row) => row.includes('b.ts'))).toBe(true)
    await lane.edit('b.ts', 'dropped')
    await lane.back('discard')
    expect(await lane.content('b.ts')).toBe('B text')
    expect(lane.savesSent()).toHaveLength(1)
  } finally {
    lane.unmount()
  }
})

it('phone: a file opens as text with Edit, which a read-only lane does not offer', async () => {
  const lane = await renderLaneFiles({
    invoke: fakeLaneHost().invoke,
    client: 'phone',
    controller: false,
  })
  try {
    await lane.clickTreeRow('a.ts')
    expect(lane.text()).toContain('A text')
    expect(lane.container.querySelector('textarea')).toBeNull()
    expect(lane.text()).not.toContain('Edit')
  } finally {
    lane.unmount()
  }
})
