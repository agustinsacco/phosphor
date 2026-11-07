// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { FILE_READ_FAILED } from '@phosphor/shared/host-protocol-files'
import { forgetRemoteSession } from '@/stores/sessions'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { usePromptStore } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { closeEditorFile } from './closeEditorFile'
import { lanes, renderLaneFiles, resetLaneFiles } from './__fixtures__/renderLaneFiles'

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
}))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))

afterEach(() => {
  usePromptStore.setState({ requests: [] })
  resetLaneFiles()
})

const workspace = lanes.a.workspacePath
const tabs = () => workspaceFiles(useFilesStore.getState(), workspace).openFiles
let revision = 0
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (channel === 'fs:listFiles') return ['a.ts', 'b.ts']
  if (channel === 'git:statusMap') return {}
  if (channel === 'fs:readFile') return { content: 'host', size: 4, mtimeMs: 0, revision: 'r0' }
  if (channel === 'fs:writeFile') return { mtimeMs: 1, revision: `r${++revision}`, args }
  throw new Error(`Unexpected channel ${channel}`)
}
/** Close a tab, answering its dirty-close question with `choice`; what it asked, and the result. */
async function close(path: string, choice: string | undefined) {
  const asked: string[] = []
  const stop = usePromptStore.subscribe((state) => {
    for (const request of state.requests) {
      asked.push(request.title)
      usePromptStore.getState().dismiss(request, choice)
    }
  })
  let closed = false
  await act(async () => {
    closed = await closeEditorFile(workspace, `${workspace}/${path}`)
  })
  stop()
  return { asked, closed }
}

it('closing a dirty Host tab asks first, and Save sends its revision once', async () => {
  const lane = await renderLaneFiles({ invoke })
  try {
    await lane.edit('a.ts', 'edited')
    expect(await close('a.ts', undefined)).toEqual({
      asked: ['Save changes to a.ts?'],
      closed: false,
    })
    expect(tabs()).toHaveLength(1)
    expect((await close('a.ts', 'save')).closed).toBe(true)
    expect(lane.savesSent()).toEqual([['fs:writeFile', `${workspace}/a.ts`, 'edited', 'r0']])
    expect(tabs()).toHaveLength(0)
  } finally {
    lane.unmount()
  }
})

it('an uncertain tab is not closed by Save, so its edits stay', async () => {
  const lane = await renderLaneFiles({
    invoke: (channel, ...args) =>
      channel === 'fs:writeFile' ? Promise.reject(new Error('timeout')) : invoke(channel, ...args),
  })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.save('a.ts')
    expect((await close('a.ts', 'save')).closed).toBe(false)
    expect(lane.savesSent()).toHaveLength(1)
    expect(tabs()[0]).toMatchObject({ content: 'edited', saveUncertain: true })
  } finally {
    lane.unmount()
  }
})

it('one path is one buffer: reopening focuses the tab and keeps its edits and revision', async () => {
  const lane = await renderLaneFiles({ invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.clickTreeRow('b.ts')
    await lane.clickTreeRow('a.ts')
    await lane.openFromChat('a.ts')
    expect(tabs().map((f) => f.relativePath)).toEqual(['a.ts', 'b.ts'])
    expect(tabs()[0]).toMatchObject({ content: 'edited', revision: 'r0', dirty: true })
    expect(workspaceFiles(useFilesStore.getState(), workspace).activePath).toBe(`${workspace}/a.ts`)
  } finally {
    lane.unmount()
  }
})

it('a lane switch keeps the lane’s open files and its pending save', async () => {
  let settle!: (value: unknown) => void
  const lane = await renderLaneFiles({
    invoke: (channel, ...args) =>
      channel === 'fs:writeFile'
        ? new Promise((resolve) => (settle = resolve))
        : invoke(channel, ...args),
  })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.clickTreeRow('b.ts')
    await lane.save('a.ts')
    await lane.show('b')
    expect(tabs().map((f) => f.relativePath)).toEqual(['a.ts', 'b.ts'])
    expect(tabs()[0]?.saving).toBe(true)
    await act(async () => settle({ mtimeMs: 1, revision: 'r1' }))
    await lane.show('a')
    expect(tabs()[0]).toMatchObject({ content: 'edited', dirty: false, revision: 'r1' })
  } finally {
    lane.unmount()
  }
})

it('forgetting a lane mid-save drops its files, and the late reply changes nothing', async () => {
  let settle!: (value: unknown) => void
  const lane = await renderLaneFiles({
    invoke: (channel, ...args) =>
      channel === 'fs:writeFile'
        ? new Promise((resolve) => (settle = resolve))
        : invoke(channel, ...args),
  })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.save('a.ts')
    await lane.show(null)
    await act(async () => forgetRemoteSession(lanes.a.sessionId))
    expect(useFilesStore.getState().byWorkspace[workspace]).toBeUndefined()
    await act(async () => settle({ mtimeMs: 1, revision: 'r1' }))
    expect(useFilesStore.getState().byWorkspace[workspace]).toBeUndefined()
    expect(lane.savesSent()).toHaveLength(1)
  } finally {
    lane.unmount()
  }
})

it('switching lanes or closing the pane never drops a lane’s files', async () => {
  const lane = await renderLaneFiles({ invoke })
  try {
    await lane.edit('a.ts', 'edited')
    await lane.show('b')
    await lane.show(null)
    expect(tabs()[0]).toMatchObject({ content: 'edited', dirty: true })
  } finally {
    lane.unmount()
  }
})

it('a failed Host read is an error toast, as on This Mac, and opens no tab', async () => {
  const lane = await renderLaneFiles({
    invoke: (channel, ...args) =>
      channel === 'fs:readFile'
        ? // The bridge's text for a Host that could not read the file (read-features.ts).
          Promise.reject(new Error(FILE_READ_FAILED))
        : invoke(channel, ...args),
  })
  try {
    await lane.clickTreeRow('a.ts')
    await act(async () => {})
    expect(useExtensionUiStore.getState().toasts).toEqual([
      expect.objectContaining({ kind: 'error', message: 'Error: Could not read this file.' }),
    ])
    expect(tabs()).toHaveLength(0)
    expect(lane.text()).not.toContain('Loading')
  } finally {
    lane.unmount()
    useExtensionUiStore.setState({ toasts: [] })
  }
})
