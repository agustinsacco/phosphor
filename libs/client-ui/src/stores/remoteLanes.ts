import {
  bindRemoteHostView,
  refreshRemoteArtifacts,
  invalidateRemoteArtifactReads,
} from '@/features/artifacts/remoteArtifactRefresh'
import { create } from 'zustand'
import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import type { HostTarget } from '@shared/remote-host'
import { forgetRemoteSession, useSessionsStore } from './sessions'
import { useMachinesStore } from './machines'
import { useExtensionUiStore } from './extensionUi'
import { useLayoutStore } from './layout'
import { useWorkspacesStore } from './workspaces'
import { isWorktreeFolder, projectPathFor } from '@/lib/path'
import { representativeGroupPath } from '@/features/sessions/groupSessions'
import {
  localLaneGroupKey,
  remoteLaneGroupKey,
  requestReveal,
} from '@/features/sessions/laneReveal'

const LOCAL: HostTarget = Object.freeze({ kind: 'local' })
export const REMOTE_NOT_READY = 'Machine not connected. Wait for reconnection.'

export function connectionLabel(state: HostConnectionView['state'] | undefined): string {
  // A first attempt is not a reconnection; the wait notes (`connectingTo`) say the same.
  return state === 'ready'
    ? 'Connected'
    : state === 'connecting'
      ? 'Connecting'
      : state === 'reconnecting'
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

/** These retry on their own; every other state that is not ready needs the user. */
export function hostReconnecting(state: HostConnectionView['state'] | undefined): boolean {
  return state === 'connecting' || state === 'reconnecting'
}

/** Still reaching this Host: retrying, or the first snapshot has not listed it yet. */
export function hostPending(s: { hosts: HostsSnapshot; snapshotStatus: string }, hostId: string) {
  const host = s.hosts[hostId]
  return host ? hostReconnecting(host.state) : s.snapshotStatus === 'loading'
}

/** What a screen says while a Host retries: a first attempt connects, a later one reconnects. */
export function connectingTo(hostId: string, state: HostConnectionView['state'] | undefined) {
  return `${state === 'reconnecting' ? 'Reconnecting' : 'Connecting'} to ${machineLabel(hostId)}…`
}

/** Null for a local session. Otherwise its Host's state, and whether this client holds the lane. */
function heldLane(sessionId: string) {
  const entry = useSessionsStore.getState().live[sessionId]
  if (entry?.target?.kind !== 'remote') return null
  const host = useRemoteLanesStore.getState().hosts[entry.target.hostId]
  const lane = host?.lanes.find((item) => item.laneId === entry.laneId)
  const held =
    !!host?.capabilities.includes('sessions.control') && lane?.control.controller?.self === true
  return { state: host?.state, held }
}

export function canControlSession(sessionId: string): boolean {
  const lane = heldLane(sessionId)
  return !lane || (lane.state === 'ready' && lane.held)
}

/**
 * Watched but not held, on a Host that could hand it over now. While the Host
 * is not ready the lane only waits: its composer stays, locked, and says why.
 */
export function readOnlyLane(sessionId: string): boolean {
  const lane = heldLane(sessionId)
  return !!lane && lane.state === 'ready' && !lane.held
}

export const useRemoteLanesStore = create<{
  hosts: HostsSnapshot
  snapshotStatus: 'idle' | 'loading' | 'ready' | 'error'
  filter: string
  error: string | null
  setFilter: (filter: string) => void
}>((set) => ({
  hosts: {},
  snapshotStatus: 'idle',
  filter: 'local',
  error: null,
  setFilter: (filter) => set({ filter }),
}))

bindRemoteHostView((hostId) => useRemoteLanesStore.getState().hosts[hostId])

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
  if (useSessionsStore.getState().navSeq === nav) {
    useSessionsStore.getState().activate(info.sessionId)
    await refreshRemoteArtifacts(info.sessionId)
  }
}

export function alignLaneMachineFilter(machine: string): void {
  const store = useRemoteLanesStore.getState()
  if (store.filter !== 'all' && store.filter !== machine) store.setFilter(machine)
}

function localRevealGroup(workspacePath: string): string {
  const { gitByCwd, live } = useSessionsStore.getState()
  const knownPaths = new Set(
    useWorkspacesStore
      .getState()
      .recents.filter((workspace) => !isWorktreeFolder(workspace.path))
      .map((workspace) => workspace.path),
  )
  knownPaths.add(workspacePath)
  for (const entry of Object.values(live))
    if (entry.target?.kind !== 'remote') knownPaths.add(entry.workspacePath)
  const projectKey = projectPathFor(workspacePath, gitByCwd[workspacePath])
  const groupPaths = [...knownPaths].filter(
    (path) => projectPathFor(path, gitByCwd[path]) === projectKey,
  )
  return representativeGroupPath(projectKey, groupPaths)
}

type LaneDestination = { sessionId: string } | { hostId: string; laneId: string }

/** All notice and row navigation commits only after its destination is available. */
export async function navigateToLane(destination: LaneDestination): Promise<boolean> {
  const sessions = useSessionsStore.getState()
  const live = 'sessionId' in destination ? sessions.live[destination.sessionId] : undefined
  const remote =
    'hostId' in destination
      ? destination
      : live?.target?.kind === 'remote' && live.laneId
        ? { hostId: live.target.hostId, laneId: live.laneId }
        : undefined
  const nav = sessions.claimNav()
  let superseded = false
  const offPage = useLayoutStore.subscribe((state, previous) => {
    if (state.page !== previous.page) superseded = true
  })
  const offFilter = useRemoteLanesStore.subscribe((state, previous) => {
    if (state.filter !== previous.filter) superseded = true
  })
  const stopWatching = (): void => {
    offPage()
    offFilter()
  }
  const current = (): boolean => !superseded && useSessionsStore.getState().navSeq === nav
  const unavailable = (hosts = useRemoteLanesStore.getState().hosts): string | undefined => {
    if (!remote) return
    const host = hosts[remote.hostId]
    const label = machineLabel(remote.hostId)
    if (host?.state !== 'ready') return `${label} is offline`
    if (!host.lanes.some((lane) => lane.laneId === remote.laneId))
      return `This lane was removed on ${label}`
    return undefined
  }
  try {
    const problem = unavailable()
    if (problem) throw new Error(problem)
    let sessionId = 'sessionId' in destination ? destination.sessionId : undefined
    if (remote) {
      const info = await window.phosphor.invoke('hosts:openLane', remote.hostId, remote.laneId)
      await useSessionsStore
        .getState()
        .adoptSession(info.sessionId, info.workspacePath, undefined, info)
      sessionId = info.sessionId
    }
    if (!current()) return false
    const problemAfterOpen = unavailable()
    if (problemAfterOpen) throw new Error(problemAfterOpen)
    const entry = sessionId ? useSessionsStore.getState().live[sessionId] : undefined
    if (!sessionId || !entry) throw new Error('This lane was removed on This Mac')
    stopWatching()
    alignLaneMachineFilter(remote?.hostId ?? 'local')
    useSessionsStore.getState().activate(sessionId)
    const lane = remote
      ? useRemoteLanesStore
          .getState()
          .hosts[remote.hostId]?.lanes.find((lane) => lane.laneId === remote.laneId)
      : undefined
    requestReveal(
      remote && lane
        ? remoteLaneGroupKey(remote.hostId, lane.repositoryId)
        : localLaneGroupKey(localRevealGroup(entry.workspacePath)),
    )
    useRemoteLanesStore.setState({ error: null })
    if (remote) await refreshRemoteArtifacts(sessionId)
    return (
      useSessionsStore.getState().activeSessionId === sessionId &&
      useLayoutStore.getState().page === null
    )
  } catch {
    if (!current()) return false
    let problem = unavailable()
    if (remote && !problem) {
      try {
        problem = unavailable(await window.phosphor.invoke('hosts:snapshot'))
      } catch {
        // No error payloads from the Host are shown to the user.
      }
    }
    if (!current()) return false
    const message =
      problem ?? (remote ? 'Could not open the remote lane.' : 'This lane was removed on This Mac')
    useRemoteLanesStore.setState({ error: message })
    useExtensionUiStore.getState().pushToast(message, 'error')
    return false
  } finally {
    stopWatching()
  }
}

export async function openRemoteLane(hostId: string, laneId: string): Promise<boolean> {
  return navigateToLane({ hostId, laneId })
}

/** Main owns the bounded cache. Refetch serially, and reject replies after detach. */
export function attachRemoteLanesListener(): () => void {
  useRemoteLanesStore.setState({ snapshotStatus: 'loading' })
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
          const previousHosts = useRemoteLanesStore.getState().hosts
          useRemoteLanesStore.setState({ hosts, snapshotStatus: 'ready' })
          const currentId = useSessionsStore.getState().activeSessionId
          const current = currentId ? useSessionsStore.getState().live[currentId] : undefined
          if (currentId && current?.target?.kind === 'remote') {
            const host = hosts[current.target.hostId]
            const previous = previousHosts[current.target.hostId]
            if (
              host?.state === 'ready' &&
              (previous?.state !== 'ready' ||
                host.connectionToken !== previous.connectionToken ||
                host.cursor?.epoch !== previous.cursor?.epoch)
            )
              void refreshRemoteArtifacts(currentId)
          }
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
      if (active) useRemoteLanesStore.setState({ snapshotStatus: 'error' })
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
    if (state.activeSessionId !== previous.activeSessionId) {
      invalidateRemoteArtifactReads()
      reportFocus()
      if (state.activeSessionId) void refreshRemoteArtifacts(state.activeSessionId)
    }
  })
  reportFocus()
  const offChanged = window.phosphor.onHostsChanged(() => void refresh())
  const offAttention = window.phosphor.onHostAttention((event) => {
    void refresh()
    const { activeSessionId, live } = useSessionsStore.getState()
    const adopted = Object.values(live).find(
      (entry) =>
        entry.target?.kind === 'remote' &&
        entry.target.hostId === event.hostId &&
        entry.laneId === event.laneId,
    )
    if (
      adopted?.phosphorId === activeSessionId &&
      useLayoutStore.getState().page === null &&
      document.hasFocus()
    )
      return
    void import('./extensionUi').then(({ useExtensionUiStore }) => {
      if (!active) return
      useExtensionUiStore.getState().notify({
        // Remote sessions skip the local settled path. Sharing their key also
        // replaces any existing lane notice instead of adding a second card.
        sessionId: adopted?.phosphorId,
        title: `${machineLabel(event.hostId)} · ${event.title}`,
        message: event.kind,
        receipt: {
          facts: event.receipt,
          machine: machineLabel(event.hostId),
          machineId: event.hostId,
          laneId: event.laneId,
          at: event.at,
        },
        kind: event.kind === 'failed' ? 'error' : 'info',
        openLabel: 'Open lane',
        onOpen: () => openRemoteLane(event.hostId, event.laneId),
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
    invalidateRemoteArtifactReads()
    offFocus()
    offChanged()
    offAttention()
    offOpen()
    window.removeEventListener('focus', onFocus)
    useRemoteLanesStore.setState({
      hosts: {},
      snapshotStatus: 'idle',
      filter: 'local',
      error: null,
    })
  }
}
