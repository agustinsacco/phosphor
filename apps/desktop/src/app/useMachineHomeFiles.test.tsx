// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'
import { useMachineHomeFiles } from './useMachineHomeFiles'
import { MachineFilesPane } from '@/features/files/MachineFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: () => null,
}))
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => null }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => null }))
vi.mock('@/features/chat/SessionMenu', () => ({ SessionMenu: () => null }))
vi.mock('@/features/chat/composer/SwarmSwitch', () => ({ SwarmBadge: () => null }))
function Home(): React.JSX.Element {
  const files = useMachineHomeFiles()
  return (
    <>
      <TopBar workspacePath="/mac" machineFiles={files} />
      {files.open && files.hostId && <MachineFilesPane hostId={files.hostId} />}
    </>
  )
}
it('offers only readable Host files on home and resets browsing on switch or lane activation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockResolvedValue([])
  Object.assign(window, { phosphor: { invoke } })
  const ready = { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: ['workspaces.read' as const] }
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: ready }, filter: MOCK_HOST_ID })
  useSessionsStore.setState({ activeSessionId: null })
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.append(container)
  const button = () => container.querySelector<HTMLButtonElement>('[aria-label="Files pane"]')
  try {
    await act(async () => root.render(<Home />))
    expect(button()?.disabled).toBe(false)
    await act(async () => button()?.click())
    expect(container.querySelector('select[aria-label="Repository"]')?.textContent).toContain(
      ready.repositories[0]!.name,
    )
    await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
    expect(button()).toBeNull()
    expect(container.querySelector('select')).toBeNull()
    await act(async () => useRemoteLanesStore.setState({ filter: MOCK_HOST_ID }))
    expect(container.querySelector('select')).toBeNull()
    await act(async () => button()?.click())
    expect(container.querySelector('select')).not.toBeNull()
    await act(async () =>
      useSessionsStore.setState({
        activeSessionId: mockRemoteInfo.sessionId,
        live: {
          [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
        },
      }),
    )
    expect(container.querySelector('select')).toBeNull()
    await act(async () => useSessionsStore.setState({ activeSessionId: null }))
    expect(container.querySelector('select')).toBeNull()
    for (const [state, capabilities, reason] of [
      ['down', ['workspaces.read'], 'Machine not connected. Wait for reconnection.'],
      ['ready', [], 'Not available on remote lanes yet.'],
    ] as const) {
      await act(async () =>
        useRemoteLanesStore.setState({
          hosts: { [MOCK_HOST_ID]: { ...ready, state, capabilities: [...capabilities] } },
        }),
      )
      expect(button()?.disabled).toBe(true)
      expect(button()?.getAttribute('data-tooltip')).toBe(reason)
    }
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
