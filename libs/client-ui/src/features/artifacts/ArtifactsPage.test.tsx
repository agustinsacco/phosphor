// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ArtifactsPage } from './ArtifactsPage'
import { useArtifactsStore } from '@/stores/artifacts'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.mock('./ArtifactsPane', () => ({ ArtifactWorkspace: () => null }))
it.each([
  ['local', MOCK_HOST_ID, 'local'],
  [MOCK_HOST_ID, 'local', MOCK_HOST_ID],
])('artifact library switches machine without stale rows: %j', async (...sequence) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue([]) })
  useMachinePagesStore.setState({ artifactsMachine: '' })
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      remote: { ...mockRemoteInfo, phosphorId: 'remote' },
    },
  })
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: ['artifacts.read'] },
    },
  })
  useArtifactsStore.setState({ bySession: {} })
  useArtifactsStore
    .getState()
    .addLocal('mac', { title: 'Mac document', type: 'markdown', content: 'Mac' })
  useArtifactsStore
    .getState()
    .addLocal('remote', { title: 'Bee document', type: 'markdown', content: 'Bee' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    for (const id of sequence) {
      await act(async () => {
        useRemoteLanesStore.getState().setFilter(id)
        root.render(<ArtifactsPage />)
      })
      expect(container.textContent).toContain(id === 'local' ? 'Mac document' : 'Bee document')
      expect(container.textContent).not.toContain(id === 'local' ? 'Bee document' : 'Mac document')
    }
    await act(async () => {
      useMachinePagesStore.setState({ artifactsMachine: MOCK_HOST_ID })
      useRemoteLanesStore.setState({ hosts: {} })
    })
    expect(container.textContent).toContain('Machine not connected. Wait for reconnection.')
    expect(container.textContent).not.toContain('Mac document')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  ['ready and offering artifacts', 'ready', ['artifacts.read'], true],
  ['ready without artifacts', 'ready', ['sessions.read'], false],
  ['reconnecting', 'reconnecting', ['artifacts.read'], false],
] as const)(
  'All machines lists a live Host lane artifact only while its Host is %s',
  async (_, state, capabilities, listed) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue([]) })
    useMachinePagesStore.setState({ artifactsMachine: 'all' })
    useSessionsStore.setState({ live: { remote: { ...mockRemoteInfo, phosphorId: 'remote' } } })
    useRemoteLanesStore.setState({
      hosts: {
        [MOCK_HOST_ID]: {
          ...mockRemoteHosts[MOCK_HOST_ID]!,
          state,
          capabilities: [...capabilities],
        },
      },
    })
    useArtifactsStore.setState({ bySession: {} })
    useArtifactsStore
      .getState()
      .addLocal('remote', { title: 'Bee document', type: 'markdown', content: 'Bee' })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<ArtifactsPage />))
      expect(container.textContent?.includes('Bee document')).toBe(listed)
    } finally {
      act(() => root.unmount())
      container.remove()
      useMachinePagesStore.setState({ artifactsMachine: '' })
      vi.unstubAllGlobals()
    }
  },
)

it('shows the unavailable service rather than Desktop rows for a saved This Mac selection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue([]) })
  useMachinePagesStore.setState({ artifactsMachine: 'local' })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, state: 'down', local: true } },
  })
  useSessionsStore.setState({ live: { mac: { phosphorId: 'mac', workspacePath: '/mac' } } })
  const c = document.createElement('div'),
    root = createRoot(c)
  try {
    await act(async () => root.render(<ArtifactsPage />))
    expect(c.textContent).toContain('Machine not connected')
    expect(c.textContent).not.toContain('Mac document')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
