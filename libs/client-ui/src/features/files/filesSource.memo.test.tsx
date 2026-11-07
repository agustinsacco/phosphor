// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { lanes, renderLaneFiles, resetLaneFiles, updateHost } from './__fixtures__/renderLaneFiles'

const counts = vi.hoisted(() => ({ attach: 0, explorer: 0 }))
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
vi.mock('@/stores/files', async (importOriginal) => {
  const files = await importOriginal<typeof import('@/stores/files')>()
  return {
    ...files,
    attachFilesSource: (...args: Parameters<typeof files.attachFilesSource>) => {
      counts.attach++
      files.attachFilesSource(...args)
    },
  }
})
vi.mock('./FileExplorer', async (importOriginal) => {
  const { FileExplorer } = await importOriginal<typeof import('./FileExplorer')>()
  return {
    FileExplorer: (props: Parameters<typeof FileExplorer>[0]) => {
      counts.explorer++
      return <FileExplorer {...props} />
    },
  }
})

afterEach(resetLaneFiles)

async function invoke(channel: string): Promise<unknown> {
  if (channel === 'fs:listFiles') return ['a.ts']
  if (channel === 'git:statusMap') return {}
  throw new Error(`Unexpected channel ${channel}`)
}

const touchLane = (laneId: string) =>
  act(async () =>
    updateHost((host) => ({
      ...host,
      lanes: host.lanes.map((lane) =>
        lane.laneId === laneId ? { ...lane, updatedAt: new Date(9).toISOString() } : lane,
      ),
    })),
  )

it('an update to another lane on the Host re-renders nothing in this lane’s Files', async () => {
  const lane = await renderLaneFiles({ invoke })
  expect(lane.files()).toEqual(['a.ts'])
  counts.attach = counts.explorer = 0
  await touchLane(lanes.b.laneId)
  expect(counts).toEqual({ attach: 0, explorer: 0 })
  await touchLane(lanes.a.laneId)
  expect(counts.attach).toBe(1)
  lane.unmount()
})
