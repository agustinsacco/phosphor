import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useWorkspacesStore } from '@/stores/workspaces'

/** The `window.phosphor` a mounted Sidebar needs: `invoke` and the four subscriptions it opens. */
export function stubSidebarPhosphor(invoke: (...args: never[]) => unknown): void {
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke,
      onUpdateEvent: () => () => {},
      onAccountChanged: () => () => {},
      onRoutinesChanged: () => () => {},
      onSessionsChanged: () => () => {},
    },
  })
}

/** This Mac alone, with one recent workspace at `/repo`: no Hosts, the filter on This Mac. */
export function resetSidebarStores(): void {
  useMachinesStore.setState({ remoteEnabled: false, machines: [], adding: false })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  useWorkspacesStore.setState({
    recents: [{ path: '/repo', name: 'repo', lastOpenedAt: 0 }],
    hydrated: true,
  })
}
