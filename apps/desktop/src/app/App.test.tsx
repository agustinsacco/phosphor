// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { App } from './App'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useWorktreesStore } from '@/stores/worktrees'
import { useDraftsStore } from '@/stores/drafts'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('./useGlobalShortcuts', () => ({ useGlobalShortcuts: vi.fn() }))
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  attachRemoteLanesListener: () => () => {},
}))
vi.mock('@/stores/machines', async (original) => ({
  ...(await original<object>()),
  attachMachinesListener: () => () => {},
}))
vi.mock('@/stores/connectors', () => ({ attachConnectorAuthListener: () => () => {} }))
vi.mock('@/features/connectors/migrationNotice', () => ({ noticeMcpMigration: async () => {} }))
vi.mock('@/stores/sessions', async (original) => ({
  ...(await original<object>()),
  attachPiCommandsListener: () => () => {},
}))
vi.mock('./TopBar', () => ({
  TopBar: ({ machineFiles }: { machineFiles: { toggle: () => void } }) => (
    <button onClick={machineFiles.toggle}>Home Files</button>
  ),
}))
vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => null }))
vi.mock('@/features/files/FuzzyFinder', () => ({ FuzzyFinder: () => <div>Finder mounted</div> }))
vi.mock('@/features/palette/CommandPalette', () => ({
  CommandPalette: () => <div>Palette mounted</div>,
}))
vi.mock('@/features/files/RightPane', () => ({ RightPane: () => null }))
vi.mock('@/features/files/MachineFilesPane', () => ({
  MachineFilesPane: ({ hostId }: { hostId: string }) => <div>Host repositories {hostId}</div>,
}))
vi.mock('@/features/sessions/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/features/sessions/BulkDeleteModal', () => ({ BulkDeleteProgressPopover: () => null }))
vi.mock('@/features/skills/SkillsPage', () => ({ SkillsPage: () => null }))
vi.mock('@/features/routines/RoutinesPage', () => ({ RoutinesPage: () => null }))
vi.mock('@/features/artifacts/ArtifactsPage', () => ({ ArtifactsPage: () => null }))
vi.mock('@/features/machines/MachinesPage', () => ({ MachinesPage: () => null }))
vi.mock('@/features/home/WorkspaceHome', () => ({ WorkspaceHome: () => null }))
vi.mock('@/features/home/StartingChat', () => ({ StartingChat: () => null }))
vi.mock('@/features/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@/features/feedback/FeedbackModal', () => ({ FeedbackModal: () => null }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({
  ExtensionDialogHost: () => null,
  ToastHost: () => null,
}))
vi.mock('@/features/writing/TextFieldMenu', () => ({ TextFieldMenu: () => null }))
vi.mock('@/components/ContextMenu', () => ({ ContextMenuHost: () => null }))
vi.mock('@/components/PromptHost', () => ({ PromptHost: () => null }))

it.each([true, false])(
  'mounts target-correct global surfaces (lane active: %s)',
  async (laneActive) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.assign(window, {
      phosphor: {
        invoke: vi.fn(async (channel: string) =>
          channel === 'pi:health'
            ? { ok: true, version: '1.2.0' }
            : channel === 'pi:listLiveSessions'
              ? []
              : { kind: 'none' },
        ),
        onPtyStatus: () => () => {},
      },
    })
    vi.spyOn(useWorkspacesStore.getState(), 'hydrate').mockResolvedValue()
    vi.spyOn(useWorktreesStore.getState(), 'hydratePrefs').mockResolvedValue()
    vi.spyOn(useDraftsStore.getState(), 'hydrate').mockResolvedValue()
    vi.spyOn(useModelCatalogueStore.getState(), 'hydrate').mockResolvedValue()
    const id = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      activeSessionId: laneActive ? id : null,
      live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
    })
    useWorkspacesStore.setState({ homePath: '/mac' })
    useRemoteLanesStore.setState({ filter: 'bee1-home' })
    useLayoutStore.setState({ sidebarVisible: false })
    const container = document.createElement('div'),
      root = createRoot(container)
    try {
      await act(async () => root.render(<App />))
      expect(container.textContent).toContain('Finder mounted')
      expect(container.textContent).toContain('Palette mounted')
      expect(useGlobalShortcuts).toHaveBeenLastCalledWith(true)
      if (!laneActive) {
        await act(async () => container.querySelector('button')?.click())
        expect(container.textContent).toContain('Host repositories bee1-home')
        await act(async () => useRemoteLanesStore.setState({ filter: 'local' }))
        expect(container.textContent).not.toContain('Host repositories')
      }
    } finally {
      act(() => root.unmount())
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)
