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
import { useLayoutStore } from '@/stores/layout'
import { useRemoteFileSelection } from '@/features/files/remoteFileSelection'
import { suggestedFileName } from './artifactKinds'
import type { HostCapability } from '@shared/remote-host'
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

const ALL_WRITE: HostCapability[] = [
  'sessions.read',
  'sessions.control',
  'workspaces.read',
  'workspaces.write',
  'artifacts.read',
]

/** The mock Host with these capabilities, its lane held by this client or another one. */
function laneHost(capabilities: HostCapability[], held: boolean) {
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  return {
    ...host,
    capabilities,
    lanes: host.lanes.map((lane) => ({
      ...lane,
      control: {
        ...lane.control,
        controller: {
          label: held ? 'This Desktop' : 'Another Desktop',
          connected: true,
          self: held,
        },
      },
    })),
  }
}

it.each([
  ['a viewer', ALL_WRITE, false, 'Take control first.'],
  [
    'a Host without file editing',
    ALL_WRITE.filter((c) => c !== 'workspaces.write'),
    true,
    'This Host does not offer file editing to this device.',
  ],
])(
  'remote artifact write is disabled for %s, with the reason the Host Files pane would refuse it',
  async (_, capabilities, held, reason) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const id = mockRemoteInfo.sessionId
    const invoke = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('phosphor', { invoke })
    useSessionsStore.setState({ live: { [id]: { ...mockRemoteInfo, phosphorId: id } } })
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: laneHost(capabilities, held) } })
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
      const write = container.querySelector<HTMLButtonElement>(`[data-tooltip="${reason}"]`)
      expect(write?.disabled).toBe(true)
      await act(async () => write?.click())
      expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('fs:writeFile')
    } finally {
      act(() => root.unmount())
      container.remove()
      useRemoteLanesStore.setState({ hosts: {} })
      vi.unstubAllGlobals()
    }
  },
)

it.each([
  ['a new file', null],
  ['an existing file at its read revision', 'a'.repeat(64)],
])(
  'remote artifact writes %s into the Host lane and opens it there; downloads name the local machine',
  async (_, revision) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const id = mockRemoteInfo.sessionId
    let written = false
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'fs:writeFile') written = true
      if (channel !== 'fs:readFile') return { mtimeMs: 1, revision: 'b'.repeat(64) }
      if (!written && revision === null) throw new Error('missing')
      return { content: 'old', binary: false, size: 3, revision: revision ?? 'b'.repeat(64) }
    })
    vi.stubGlobal('phosphor', { invoke })
    useSessionsStore.setState({ live: { [id]: { ...mockRemoteInfo, phosphorId: id } } })
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: laneHost(ALL_WRITE, true) } })
    useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
    useArtifactsStore
      .getState()
      .addLocal(id, { title: 'Remote artifact', type: 'markdown', content: 'Remote document' })
    const name = suggestedFileName(Object.values(useArtifactsStore.getState().bySession[id]!)[0]!)
    const target = `${mockRemoteInfo.workspacePath}/${name}`
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(<ArtifactsPane sessionId={id} workspacePath={mockRemoteInfo.workspacePath} />),
      )
      expect(
        container.querySelector('[data-tooltip="Save source to This computer…"]'),
      ).not.toBeNull()
      const write = container.querySelector<HTMLButtonElement>(
        '[data-tooltip="Write into workspace and open in Files"]',
      )
      expect(write?.disabled).toBe(false)
      await act(async () => write?.click())
      expect(invoke).toHaveBeenCalledWith('fs:writeFile', target, 'Remote document', revision)
      expect(useRemoteFileSelection.getState().bySession[id]?.path).toBe(name)
      expect(useLayoutStore.getState().bySession[id]?.pane).toBe('files')
    } finally {
      act(() => root.unmount())
      container.remove()
      useRemoteLanesStore.setState({ hosts: {} })
      useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
      vi.unstubAllGlobals()
    }
  },
)

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
