// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RightPane } from './RightPane'
import { useFilesStore } from '@/stores/files'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

// The settings store reads the colour scheme when the Files pane's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoDiff: () => null,
  MonacoEditor: ({ value, path }: { value: string; path: string }) => (
    <pre data-model={path}>{value}</pre>
  ),
}))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))
afterEach(() => {
  useFilesStore.setState({ entries: {}, expanded: {}, byWorkspace: {}, listErrors: {} })
  vi.unstubAllGlobals()
})

it('Files shows each lane its own file through Mac → bee1 → another lane → bee1 → Mac', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = () => {}
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])!
  host.capabilities = ['workspaces.read']
  host.lanes = ['a', 'b'].map((laneId) => ({ ...host.lanes[0]!, laneId }))
  const lane = (laneId: string) => ({
    ...mockRemoteInfo,
    sessionId: `remote-${laneId}`,
    phosphorId: `remote-${laneId}`,
    laneId,
    workspacePath: `host:${MOCK_HOST_ID}/lane:${laneId}`,
  })
  const [a, b] = [lane('a'), lane('b')]
  useSessionsStore.setState({ live: { [a.sessionId]: a, [b.sessionId]: b } })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useLayoutStore.setState({
    bySession: Object.fromEntries(
      [a, b].map((l) => [l.sessionId, { pane: 'files', expanded: false, side: 'right', size: 45 }]),
    ),
  })
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string, path: string) => {
      if (channel === 'fs:listFiles') return ['src/same.ts']
      if (channel === 'git:statusMap') return { 'src/same.ts': ' M' }
      if (channel === 'fs:readFile')
        return { content: path.includes('lane:a') ? 'BEE1 A' : 'BEE1 B', revision: 'r' }
      throw new Error('unexpected local call')
    }),
  })
  const container = document.createElement('div'),
    root = createRoot(container)
  const row = (selector: string) => container.querySelector<HTMLElement>(selector)
  try {
    for (const target of [null, a, b, a, null]) {
      await act(async () =>
        root.render(
          target ? (
            <RightPane workspacePath={target.workspacePath} sessionId={target.sessionId} />
          ) : (
            <div>MAC VIEW</div>
          ),
        ),
      )
      if (!target) {
        expect(container.textContent).toBe('MAC VIEW')
        continue
      }
      const other = target === a ? 'BEE1 B' : 'BEE1 A'
      expect(container.textContent).not.toContain(other)
      const folder = row(`[data-path="${target.workspacePath}/src"]`)
      if (folder?.getAttribute('aria-expanded') !== 'true') await act(async () => folder?.click())
      await act(async () => row(`[data-path="${target.workspacePath}/src/same.ts"]`)?.click())
      expect(container.textContent).toContain(target === a ? 'BEE1 A' : 'BEE1 B')
      expect(container.textContent).not.toContain(other)
      expect(row('[data-model]')?.getAttribute('data-model')).toBe(
        `${target.workspacePath}/src/same.ts`,
      )
    }
  } finally {
    act(() => root.unmount())
  }
})
