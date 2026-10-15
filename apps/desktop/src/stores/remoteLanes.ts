import { create } from 'zustand'
import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import type { HostTarget } from '@shared/remote-host'
import { forgetRemoteSession, useSessionsStore } from './sessions'
import { useMachinesStore } from './machines'

const LOCAL: HostTarget = Object.freeze({ kind: 'local' })
export const REMOTE_NOT_READY = 'Machine not connected. Wait for reconnection.'

export function connectionLabel(state: HostConnectionView['state'] | undefined): string {
  return state === 'ready'
    ? 'Connected'
    : state === 'connecting' || state === 'reconnecting'
      ? 'Reconnecting'
      : 'Down'
}

export const REMOTE_UNAVAILABLE = 'Not available on remote lanes yet.'

export function useActiveMachine(): HostTarget {
  return useSessionsStore((s) =>
    s.activeSessionId ? (s.live[s.activeSessionId]?.target ?? LOCAL) : LOCAL,
  )
}

/** Navigation follows the active lane, or the sidebar machine on home. */
export function useNavigationHostId(): string | undefined {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const target = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId]?.target : undefined,
  )
  const filter = useRemoteLanesStore((s) => s.filter)
  if (activeSessionId) return target?.kind === 'remote' ? target.hostId : undefined
  return filter !== 'local' && filter !== 'all' ? filter : undefined
}

export function machineLabel(hostId: string): string {
  return (
    useMachinesStore.getState().machines.find((machine) => machine.id === hostId)?.label ?? hostId
  )
}

export function canReadHost(host: HostConnectionView): boolean {
  return host.capabilities.includes('sessions.read')
}

export function canControlSession(sessionId: string): boolean {
  const entry = useSessionsStore.getState().live[sessionId]
  if (entry?.target?.kind !== 'remote') return true
  const host = useRemoteLanesStore.getState().hosts[entry.target.hostId]
  const lane = host?.lanes.find((item) => item.laneId === entry.laneId)
  return (
    host?.state === 'ready' &&
    host.capabilities.includes('sessions.control') &&
    lane?.control.controller?.self === true
  )
}

export const useRemoteLanesStore = create<{
  hosts: HostsSnapshot
  filter: string
  error: string | null
  setFilter: (filter: string) => void
}>((set) => ({
  hosts: {},
  filter: 'local',
  error: null,
  setFilter: (filter) => set({ filter }),
}))

// Window-local selection survives sidebar remounts, but not account or directory removal.
useMachinesStore.subscribe((state, previous) => {
  const { filter, setFilter } = useRemoteLanesStore.getState()
  if (
    !state.remoteEnabled ||
    (previous.machines.some((machine) => machine.id === filter) &&
      !state.machines.some((machine) => machine.id === filter))
  )
    setFilter('local')
})

export async function adoptRemoteLane(info: LiveSessionInfo, nav: number): Promise<void> {
  if (info.target?.kind !== 'remote' || !info.laneId) throw new Error('Invalid remote lane.')
  await useSessionsStore
    .getState()
    .adoptSession(info.sessionId, info.workspacePath, undefined, info)
  if (useSessionsStore.getState().navSeq === nav)
    useSessionsStore.getState().activate(info.sessionId)
}

export async function openRemoteLane(hostId: string, laneId: string): Promise<void> {
  const nav = useSessionsStore.getState().claimNav()
  try {
    await adoptRemoteLane(await window.phosphor.invoke('hosts:openLane', hostId, laneId), nav)
    useRemoteLanesStore.setState({ error: null })
  } catch {
    useRemoteLanesStore.setState({ error: 'Could not open the remote lane.' })
  }
}

/** Main owns the bounded cache. Refetch serially, and reject replies after detach. */
export function attachRemoteLanesListener(): () => void {
  let active = true
  let fetching = false
  let dirty = false
  async function refresh(): Promise<void> {
    dirty = true
    if (fetching) return
    fetching = true
    try {
      while (active && dirty) {
        dirty = false
        const hosts = await window.phosphor.invoke('hosts:snapshot')
        if (active) {
          useRemoteLanesStore.setState({ hosts })
          for (const entry of Object.values(useSessionsStore.getState().live)) {
            if (
              entry.target?.kind === 'remote' &&
              (!hosts[entry.target.hostId] ||
                (hosts[entry.target.hostId]?.state === 'ready' &&
                  !hosts[entry.target.hostId]?.lanes.some((lane) => lane.laneId === entry.laneId)))
            )
              void forgetRemoteSession(entry.phosphorId)
          }
          const { activeSessionId, live } = useSessionsStore.getState()
          const entry = activeSessionId ? live[activeSessionId] : undefined
          if (entry?.target?.kind === 'remote' && entry.laneId) {
            const lane = hosts[entry.target.hostId]?.lanes.find(
              (lane) => lane.laneId === entry.laneId,
            )
            if (lane && lane.attention > lane.read && document.hasFocus())
              void window.phosphor
                .invoke('hosts:markRead', entry.target.hostId, entry.laneId)
                .catch(() => undefined)
          }
        }
      }
    } catch {
      // Keep the last-known in-memory list during an IPC failure.
    } finally {
      fetching = false
    }
  }
  const reportFocus = (): void => {
    const { activeSessionId, live } = useSessionsStore.getState()
    const entry = activeSessionId ? live[activeSessionId] : undefined
    const target =
      entry?.target?.kind === 'remote' && entry.laneId
        ? { hostId: entry.target.hostId, laneId: entry.laneId }
        : null
    void window.phosphor.invoke('hosts:setFocusedLane', target).catch(() => undefined)
  }
  const offFocus = useSessionsStore.subscribe((state, previous) => {
    if (state.activeSessionId !== previous.activeSessionId) reportFocus()
  })
  reportFocus()
  const offChanged = window.phosphor.onHostsChanged(() => void refresh())
  const offAttention = window.phosphor.onHostAttention((event) => {
    void refresh()
    const { activeSessionId, live } = useSessionsStore.getState()
    const entry = activeSessionId ? live[activeSessionId] : undefined
    if (
      entry?.target?.kind === 'remote' &&
      entry.target.hostId === event.hostId &&
      entry.laneId === event.laneId &&
      document.hasFocus()
    )
      return
    void import('./extensionUi').then(({ useExtensionUiStore }) => {
      if (!active) return
      useExtensionUiStore.getState().notify({
        title: `${machineLabel(event.hostId)} · ${event.title}`,
        message: event.kind,
        kind: event.kind === 'failed' ? 'error' : 'info',
        openLabel: 'Open lane',
        onOpen: () => void openRemoteLane(event.hostId, event.laneId),
      })
    })
  })
  const offOpen = window.phosphor.onHostOpenLane(
    ({ hostId, laneId }) => void openRemoteLane(hostId, laneId),
  )
  const onFocus = (): void => {
    void refresh()
  }
  window.addEventListener('focus', onFocus)
  void refresh()
  return () => {
    active = false
    offFocus()
    offChanged()
    offAttention()
    offOpen()
    window.removeEventListener('focus', onFocus)
    useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  }
}
