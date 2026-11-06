// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFileTarget } from './SessionFileTarget'
import { RightPane } from './RightPane'
import { PathLink } from '@/features/chat/tools/PathLink'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { openFileInWorkspace, useLayoutStore } from '@/stores/layout'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
// The settings store reads the colour scheme when the Files pane's modules load.
vi.hoisted(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {} }) as unknown as MediaQueryList
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoDiff: () => null,
  MonacoEditor: ({
    value,
    path,
    reveal,
  }: {
    value: string
    path: string
    reveal?: { line: number }
  }) => (
    <pre data-model={path} data-line={reveal?.line}>
      {value}
    </pre>
  ),
}))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))
afterEach(() => vi.unstubAllGlobals())
it('opens a Host absolute tool path through an explicit lane and never reads the identical Mac path', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = () => {}
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
  if (!host) throw new Error('fixture')
  host.capabilities = ['workspaces.read']
  host.lanes = host.lanes.map((l) => ({ ...l, cwd: '/same/repo' }))
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  const id = mockRemoteInfo.sessionId
  useSessionsStore.setState({
    activeSessionId: id,
    live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
  })
  useLayoutStore.setState({
    bySession: { [id]: { pane: 'files', expanded: false, side: 'right', size: 45 } },
  })
  const invoke = vi.fn(async (channel: string, path: string) => {
    if (channel === 'fs:listFiles') return ['src/file.ts']
    if (channel === 'git:statusMap') throw new Error('not git')
    if (channel === 'fs:readFile' && path === `${mockRemoteInfo.workspacePath}/src/file.ts`)
      return { content: 'HOST CONTENT', binary: false, revision: 'a'.repeat(64) }
    throw new Error('Local disk must never run')
  })
  vi.stubGlobal('phosphor', { invoke })
  const element = document.createElement('div'),
    root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <>
          <SessionFileTarget.Provider value={id}>
            <PathLink path="/same/repo/src/file.ts" line={17} />
          </SessionFileTarget.Provider>
          <RightPane workspacePath={mockRemoteInfo.workspacePath} sessionId={id} />
        </>,
      ),
    )
    await act(async () => element.querySelector<HTMLElement>('button')?.click())
    expect(element.textContent).toContain('HOST CONTENT')
    expect(element.textContent).toContain('Git status is unavailable')
    expect(element.querySelector('[data-line="17"]')).not.toBeNull()
    expect(invoke.mock.calls.some(([, path]) => path === '/same/repo/src/file.ts')).toBe(false)
    await expect(
      openFileInWorkspace(mockRemoteInfo.workspacePath, '/outside/file.ts', undefined, id),
    ).rejects.toThrow('Not available')
    expect(invoke.mock.calls.every(([, path]) => path.startsWith('host:'))).toBe(true)
  } finally {
    act(() => root.unmount())
  }
})
