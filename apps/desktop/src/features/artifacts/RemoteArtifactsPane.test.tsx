// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RemoteArtifactsPane } from './RemoteArtifactsPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useArtifactsStore } from '@/stores/artifacts'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.mock('./ArtifactsPane', () => ({ ArtifactsPane: () => <p>Artifact viewer</p> }))
it('requires ready artifact capability and discards replies after capability loss', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const hostId = mockRemoteInfo.target?.kind === 'remote' ? mockRemoteInfo.target.hostId : ''
  const sessionId = mockRemoteInfo.sessionId
  useSessionsStore.setState({
    live: {
      [sessionId]: {
        phosphorId: sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
  })
  let resolve: ((value: []) => void) | undefined
  const invoke = vi.fn(
    () =>
      new Promise<[]>((r) => {
        resolve = r
      }),
  )
  vi.stubGlobal('phosphor', { invoke })
  const hydrate = vi.spyOn(useArtifactsStore.getState(), 'hydrate')
  const container = document.createElement('div')
  const root = createRoot(container)
  const view = { state: 'ready' as const, capabilities: [], lanes: [], repositories: [] }
  try {
    await act(async () => {
      useRemoteLanesStore.setState({ hosts: { [hostId]: view } })
      root.render(
        <RemoteArtifactsPane sessionId={sessionId} workspacePath={mockRemoteInfo.workspacePath} />,
      )
    })
    expect(container.textContent).toContain('Not available on remote lanes yet.')
    expect(invoke).not.toHaveBeenCalled()
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [hostId]: { ...view, capabilities: ['artifacts.read'] } },
      }),
    )
    expect(invoke).toHaveBeenCalledWith('artifacts:forSession', sessionId)
    await act(async () => useRemoteLanesStore.setState({ hosts: { [hostId]: view } }))
    await act(async () => resolve?.([]))
    expect(hydrate).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Artifact viewer')
  } finally {
    act(() => root.unmount())
    hydrate.mockRestore()
    useRemoteLanesStore.setState({ hosts: {} })
    vi.unstubAllGlobals()
  }
})
