// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { lanes, renderLaneFiles, resetLaneFiles } from './__fixtures__/renderLaneFiles'

// The settings store reads the colour scheme when the Files pane's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: vi.fn(), MonacoEditor: () => null }))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))

afterEach(() => resetLaneFiles())

const workspace = lanes.a.workspacePath
/** A Host lists files only: a folder it holds no file in is not in its list. */
function host(files: string[]) {
  return async (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (channel === 'fs:listFiles') return [...files]
    if (channel === 'git:statusMap') return {}
    if (channel === 'fs:createDir') return undefined
    if (channel === 'fs:createFile') {
      files.push(String(args[0]).slice(workspace.length + 1))
      return undefined
    }
    if (channel === 'fs:readFile') return { content: '', size: 0, mtimeMs: 0, revision: 'r0' }
    throw new Error(`Unexpected channel ${channel}`)
  }
}

it('a folder made on a Host lane shows at once and takes a new file', async () => {
  const lane = await renderLaneFiles({ invoke: host(['a.ts']) })
  try {
    await lane.create('folder', 'created')
    expect(lane.calls).toContainEqual(['fs:createDir', `${workspace}/created`])
    expect(lane.files()).toEqual(['created', 'a.ts'])
    await lane.clickTreeRow('created')
    await lane.create('file', 'x.ts')
    expect(lane.calls).toContainEqual(['fs:createFile', `${workspace}/created/x.ts`])
    expect(lane.files()).toEqual(['created', 'x.ts', 'a.ts'])
  } finally {
    lane.unmount()
  }
})
