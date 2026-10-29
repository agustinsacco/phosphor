import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore, sessionPanes, type GlobalPage } from '@/stores/layout'
import { useStartingChatStore } from '@/stores/startingChat'
import { navigateToLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import type { Location } from './location'

/** URL-free facade: persisted native lane/pane semantics remain owned by their stores. */
export function useDesktopLocation(): Location {
  const active = useSessionsStore((s) => s.activeSessionId)
  const entry = useSessionsStore((s) => (active ? s.live[active] : undefined))
  const pane = useLayoutStore((s) => sessionPanes(s, active).pane)
  const page = useLayoutStore((s) => s.page)
  const starting = useStartingChatStore((s) => s.starting)
  if (page) return { to: 'page', page }
  if (active)
    return {
      to: 'lane',
      pane: pane ?? 'chat',
      lane:
        entry?.target?.kind === 'remote' && entry.laneId
          ? { hostId: entry.target.hostId, laneId: entry.laneId }
          : { sessionId: active },
    }
  return { to: starting ? 'new' : 'lanes' }
}

export async function navigateDesktop(location: Location): Promise<void> {
  if (location.to === 'lane') {
    const opened = await navigateToLane(location.lane)
    if (opened && location.pane)
      useLayoutStore.getState().setRightPane(location.pane === 'chat' ? null : location.pane)
    return
  }
  if (location.to === 'page') {
    if (location.page === 'settings') useSettingsUiStore.getState().setOpen(true)
    else useLayoutStore.getState().setPage(location.page)
    return
  }
  // New on a Host opens that Host's composer, as the sidebar's New always has.
  if (location.to === 'new' && location.machine) {
    openRemoteComposer(location.machine)
    return
  }
  if (location.to !== 'unavailable') {
    if (location.machine) useRemoteLanesStore.getState().setFilter(location.machine)
    useSessionsStore.getState().activate(null)
  }
}

/** Desktop's page links toggle their page; Machines opens on its list. */
export function toggleDesktopPage(page: GlobalPage): void {
  if (page === 'machines' && useLayoutStore.getState().page !== 'machines')
    useMachinesStore.getState().show({ kind: 'list' })
  else useLayoutStore.getState().togglePage(page)
}
