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
    activeSessionId: sessionId,
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
  const view = {
    connectionToken: 'test-connection-1',
    state: 'ready' as const,
    capabilities: [],
    lanes: [],
    repositories: [],
  }
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

it.each(['missing capability', 'failed refresh'] as const)(
  'a refusal (%s) keeps the machine chip in its header',
  async (cause) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const hostId = mockRemoteInfo.target?.kind === 'remote' ? mockRemoteInfo.target.hostId : ''
    const sessionId = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      activeSessionId: sessionId,
      live: { [sessionId]: { ...mockRemoteInfo, phosphorId: sessionId } },
    })
    const invoke = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('phosphor', { invoke })
    useRemoteLanesStore.setState({
      hosts: {
        [hostId]: {
          connectionToken: 'test-connection-1',
          state: 'ready',
          capabilities: cause === 'failed refresh' ? ['artifacts.read'] : [],
          lanes: [],
          repositories: [],
        },
      },
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <RemoteArtifactsPane
            sessionId={sessionId}
            workspacePath={mockRemoteInfo.workspacePath}
          />,
        ),
      )
      expect(container.textContent).toContain('Not available on remote lanes yet.')
      expect(container.textContent).toContain('Connected')
      expect(invoke).toHaveBeenCalledTimes(cause === 'failed refresh' ? 1 : 0)
    } finally {
      act(() => root.unmount())
    }
  },
)
