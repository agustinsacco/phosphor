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
    expect(container.textContent).toContain('Not available on remote lanes yet.')
    expect(container.textContent).not.toContain('Mac document')
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
