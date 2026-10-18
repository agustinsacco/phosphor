// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ArtifactsPane } from './ArtifactsPane'
import { RemoteArtifactsPane } from './RemoteArtifactsPane'
import { useSessionsStore } from '@/stores/sessions'
import { useArtifactsStore } from '@/stores/artifacts'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/files/MonacoEditor', () => ({ MonacoDiff: () => null }))
vi.mock('@/components/markdown/MermaidBlock', () => ({ MermaidBlock: () => null }))
vi.mock('@/components/markdown/ChartBlock', () => ({ ChartBlock: () => null }))
it.each(['repo-a', 'repo-b'])(
  'real lane artifact pane: Mac -> empty bee1 %s -> Mac',
  async (repositoryId) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue([]) })
    const id = `${mockRemoteInfo.sessionId}-${repositoryId}`
    const laneId = mockRemoteInfo.laneId!.slice(0, -1) + (repositoryId === 'repo-a' ? '8' : '7')
    const workspacePath = `host:${MOCK_HOST_ID}/lane:${laneId}`
    useSessionsStore.setState({
      activeSessionId: 'mac',
      live: { [id]: { ...mockRemoteInfo, phosphorId: id, laneId, workspacePath } },
    })
    useRemoteLanesStore.setState({
      hosts: {
        [MOCK_HOST_ID]: {
          ...mockRemoteHosts[MOCK_HOST_ID]!,
          capabilities: ['artifacts.read'],
          lanes: mockRemoteHosts[MOCK_HOST_ID]!.lanes.map((lane) => ({
            ...lane,
            laneId,
            repositoryId,
          })),
        },
      },
    })
    useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
    useArtifactsStore
      .getState()
      .addLocal('mac', { title: 'Mac artifact only', type: 'markdown', content: 'Mac document' })
    useArtifactsStore
      .getState()
      .addLocal(id, { title: 'Stale Host artifact', type: 'markdown', content: 'stale' })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<ArtifactsPane sessionId="mac" workspacePath="/mac" />))
      expect(container.textContent).toContain('Mac artifact only')
      // Keep activeSessionId on Mac deliberately: the pane must use its explicit prop.
      await act(async () =>
        root.render(<RemoteArtifactsPane sessionId={id} workspacePath={workspacePath} />),
      )
      expect(container.textContent).toContain('No artifacts yet')
      expect(container.textContent).not.toContain('Mac artifact only')
      expect(container.textContent).not.toContain('Stale Host artifact')
      await act(async () => {
        useSessionsStore.setState({ activeSessionId: 'mac' })
        root.render(<ArtifactsPane sessionId="mac" workspacePath="/mac" />)
      })
      expect(container.textContent).toContain('Mac artifact only')
      await act(async () => {
        useSessionsStore.setState({ activeSessionId: id })
        root.render(<RemoteArtifactsPane sessionId={id} workspacePath={workspacePath} />)
      })
      expect(container.textContent).toContain('No artifacts yet')
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  },
)

it('remote artifact workspace write is disabled, while downloads are explicitly on This Mac', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockResolvedValue(null)
  vi.stubGlobal('phosphor', { invoke })
  const id = mockRemoteInfo.sessionId
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
  useArtifactsStore
    .getState()
    .addLocal(id, { title: 'Remote artifact', type: 'markdown', content: 'Remote document' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ArtifactsPane sessionId={id} workspacePath={mockRemoteInfo.workspacePath} />),
    )
    const unavailable = container.querySelector<HTMLButtonElement>(
      '[data-tooltip="Not available on remote lanes yet."]',
    )
    expect(unavailable?.disabled).toBe(true)
    expect(container.querySelector('[data-tooltip="Save source to This Mac…"]')).not.toBeNull()
    await act(async () => unavailable?.click())
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('copies a reference the agent can read, once pi has named the session', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue(null) })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const piSession = '0f3c9a2e-1b2c-4d5e-8f90-1234567890ab'
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
  useArtifactsStore.getState().ingest('lane', 'artifact_create', {
    id: 'field-guide',
    title: 'Field guide',
    type: 'markdown',
    content: 'Guide',
    version: 1,
  })
  useChatStore.getState().ensure('lane')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const button = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Copy reference"]')
  try {
    await act(async () => root.render(<ArtifactsPane sessionId="lane" workspacePath="/repo" />))
    expect(button()?.disabled).toBe(true)
    await act(async () =>
      useChatStore.getState().setMeta('lane', { sessionId: piSession } as never),
    )
    expect(button()?.disabled).toBe(false)
    await act(async () => button()?.click())
    expect(writeText).toHaveBeenCalledWith(`artifact://${piSession}/field-guide`)

    // A code block promoted into the pane is not pi's, so it has no reference.
    await act(async () =>
      useArtifactsStore
        .getState()
        .addLocal('lane', { title: 'Snippet', type: 'code', content: 'x' }),
    )
    await act(async () => {
      const local = Object.keys(useArtifactsStore.getState().bySession.lane!).find((id) =>
        id.startsWith('local-'),
      )!
      useArtifactsStore.getState().select('lane', local)
    })
    expect(button()?.disabled).toBe(true)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    useChatStore.getState().remove('lane')
  }
})
