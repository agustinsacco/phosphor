import { bindServiceLaneViews, laneControlPolicy } from '@/platform/serviceLaneControl'
import { serviceScope } from './localServiceScope'
import {
  bindRemoteHostView,
  refreshRemoteArtifacts,
  invalidateRemoteArtifactReads,
} from '@/features/artifacts/remoteArtifactRefresh'
import { create } from 'zustand'
import { localMachineLabel } from '@/lib/localMachine'
import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import type { HostTarget } from '@shared/remote-host'
import { forgetRemoteSession, useSessionsStore } from './sessions'
import { hostLaneOf, type SessionHostLane } from './hostLaneOf'
import { useMachinesStore } from './machines'
import { machineCaps } from './machineCaps'
import { migrateLegacyLaneMarks } from './remoteLaneMarks'
import { rereadLanesWhosePiStarted } from './lanePiStart'
import { bindHostsSnapshotRead } from './hostsSnapshotRead'
import { useExtensionUiStore } from './extensionUi'
import { useLayoutStore } from './layout'
import {
  beginHostLaneOpening,
  isActiveLane,
  openHostLane,
  prepareOpenedLane,
  releaseHostLaneNav,
  settleOpening,
} from './hostLaneOpen'
import { remoteLaneTitle } from '@/features/sessions/remoteLaneView'
import { localRevealGroup } from '@/features/sessions/localRevealGroup'
import {
  localLaneGroupKey,
  remoteLaneGroupKey,
  requestReveal,
} from '@/features/sessions/laneReveal'
import { attachHostResourceChanges } from './hostResourceChanges'
import { removedHostLaneNotice } from './hostRefusals'
const LOCAL: HostTarget = Object.freeze({ kind: 'local' })
export { connectionLabel, REMOTE_NOT_READY } from './hostRefusals'
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

/** A machine's name: `'local'`, the sentinel the switcher, skill share and sign-in use, is This Mac. */
export function machineLabel(machine: string): string {
  if (machine === 'local' || useRemoteLanesStore.getState().hosts[machine]?.local)
    return localMachineLabel()
  return useMachinesStore.getState().machines.find((m) => m.id === machine)?.label ?? machine
}

export function canReadHost(host: HostConnectionView): boolean {
  return machineCaps(host).granted('sessions.read')
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

/** Null for This Mac's session. Otherwise its Host and lane, read from the stores now. */
export function sessionHostLane(sessionId: string): SessionHostLane | null {
  const entry = useSessionsStore.getState().live[sessionId]
  const hostId = entry?.target?.kind === 'remote' ? entry.target.hostId : undefined
  return hostLaneOf(entry, hostId ? useRemoteLanesStore.getState().hosts[hostId] : undefined)
}

/** `sessionHostLane` for a component: it re-renders when the session or its Host moves. */
export function useSessionHostLane(sessionId: string | undefined): SessionHostLane | null {
  const entry = useSessionsStore((s) => (sessionId ? s.live[sessionId] : undefined))
  const hostId = entry?.target?.kind === 'remote' ? entry.target.hostId : undefined
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  return hostLaneOf(entry, host)
}

/** Null for a local session. Otherwise its Host's state, and whether this client holds the lane. */
function heldLane(sessionId: string) {
  const remote = sessionHostLane(sessionId)
  if (!remote) return null
  const { host, lane } = remote
  const caps = machineCaps(host)
  const held = caps.granted('sessions.control') && laneControlPolicy(host?.local, lane).actionable
  return { ready: caps.ready, held }
}

export function canControlSession(sessionId: string): boolean {
  const lane = heldLane(sessionId)
  return !lane || (lane.ready && lane.held)
}

/**
 * Watched but not held, on a Host that could hand it over now. While the Host
 * is not ready the lane only waits: its composer stays, locked, and says why.
 */
export function readOnlyLane(sessionId: string): boolean {
  const lane = heldLane(sessionId)
  return !!lane && lane.ready && !lane.held
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
  setFilter: (filter) => set((s) => ({ filter: serviceScope(filter, s.hosts) })),
}))

const hostView = (hostId: string) => useRemoteLanesStore.getState().hosts[hostId]
bindRemoteHostView(hostView)
bindServiceLaneViews({ host: hostView, session: sessionHostLane })
useRemoteLanesStore.subscribe((state) => migrateLegacyLaneMarks(state.hosts))
useRemoteLanesStore.subscribe((s, prev) => rereadLanesWhosePiStarted(s.hosts, prev.hosts))

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
    // Not awaited: a new lane has no artifacts, and its first prompt must not wait.
    void refreshRemoteArtifacts(info.sessionId)
  }
}

export function alignLaneMachineFilter(machine: string): void {
  const store = useRemoteLanesStore.getState()
  if (store.filter !== 'all' && store.filter !== machine) store.setFilter(machine)
}

type LaneDestination = { sessionId: string } | { hostId: string; laneId: string }

/** Notice and row navigation. A Host lane shows `OpeningLane` at once and activates only if
 * no newer navigation came first; a failure stays in that view with Retry. */
export async function navigateToLane(destination: LaneDestination): Promise<boolean> {
  const sessions = useSessionsStore.getState()
  const live = 'sessionId' in destination ? sessions.live[destination.sessionId] : undefined
  const remote =
    'hostId' in destination
      ? destination
      : live?.target?.kind === 'remote' && live.laneId
        ? { hostId: live.target.hostId, laneId: live.laneId }
        : undefined
  let nav = sessions.claimNav()
  let stopWatching = (): void => {}
  const current = (): boolean => useSessionsStore.getState().navSeq === nav
  const unavailable = (hosts = useRemoteLanesStore.getState().hosts): string | undefined => {
    if (!remote) return
    const host = hosts[remote.hostId]
    const label = machineLabel(remote.hostId)
    if (host?.state !== 'ready') return `${label} is offline`
    if (!host.lanes.some((lane) => lane.laneId === remote.laneId))
      return removedHostLaneNotice(label)
    return undefined
  }
  try {
    const problem = unavailable()
    if (problem) throw new Error(problem)
    /** Activates the opened lane, inside its open flight; undefined when a newer navigation won. */
    const land = (sessionId: string | undefined): string | undefined => {
      if (!current()) return undefined
      const problemAfterOpen = unavailable()
      if (problemAfterOpen) throw new Error(problemAfterOpen)
      const entry = sessionId ? useSessionsStore.getState().live[sessionId] : undefined
      if (!sessionId || !entry) throw new Error(removedHostLaneNotice())
      stopWatching()
      alignLaneMachineFilter(remote?.hostId ?? 'local')
      useSessionsStore.getState().activate(sessionId)
      const lane = sessionHostLane(sessionId)?.lane
      requestReveal(
        remote && lane
          ? remoteLaneGroupKey(remote.hostId, lane.repositoryId)
          : localLaneGroupKey(localRevealGroup(entry.workspacePath)),
      )
      useRemoteLanesStore.setState({ error: null })
      return sessionId
    }
    let sessionId: string | undefined
    if (remote) {
      const host = hostView(remote.hostId)
      alignLaneMachineFilter(remote.hostId)
      const view = host?.lanes.find((lane) => lane.laneId === remote.laneId)
      nav = beginHostLaneOpening(remote, remoteLaneTitle(undefined, view?.title))
      stopWatching = watchSupersede(nav)
      sessionId = await openHostLane(remote, !!(host?.local || host?.warmOnOpen), land)
    } else sessionId = land('sessionId' in destination ? destination.sessionId : undefined)
    if (!sessionId) return false
    if (remote) await prepareOpenedLane(sessionId)
    return isActiveLane(sessionId)
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
      problem ?? (remote ? 'Could not open the remote lane.' : removedHostLaneNotice())
    useRemoteLanesStore.setState({ error: message })
    useExtensionUiStore.getState().pushToast(message, 'error')
    settleOpening(nav, message)
    return false
  } finally {
    const { opening } = useSessionsStore.getState()
    if (opening?.nav !== nav || !opening.failure) stopWatching()
  }
}

/** A page or machine supersedes both a pending open and its retained failure. */
function watchSupersede(nav: number): () => void {
  const offPage = useLayoutStore.subscribe((s, prev) => {
    if (s.page !== prev.page) releaseHostLaneNav(nav)
  })
  const offFilter = useRemoteLanesStore.subscribe((s, prev) => {
    if (s.filter !== prev.filter) releaseHostLaneNav(nav)
  })
  const offNav = useSessionsStore.subscribe((s) => {
    if (s.navSeq !== nav) stop()
  })
  const stop = (): void => [offPage, offFilter, offNav].forEach((off) => off())
  return stop
}

export async function openRemoteLane(hostId: string, laneId: string): Promise<boolean> {
  return navigateToLane({ hostId, laneId })
}

function acceptSnapshot(hosts: HostsSnapshot): void {
  useRemoteLanesStore.setState((s) => ({
    hosts,
    filter: serviceScope(s.filter, hosts),
    snapshotStatus: 'ready',
  }))
}

export function attachRemoteLanesListener(): () => void {
  useRemoteLanesStore.setState({ snapshotStatus: 'loading' })
  let active = true
  let fetching = false
  let dirty = false
  let reading: Promise<void> = Promise.resolve()
  /** Resolves once a read that started after the call has landed. */
  function refresh(): Promise<void> {
    dirty = true
    if (!fetching) reading = read()
    return reading
  }
  async function read(): Promise<void> {
    fetching = true
    try {
      while (active && dirty) {
        dirty = false
        const hosts = await window.phosphor.invoke('hosts:snapshot')
        if (active) {
          const previousHosts = useRemoteLanesStore.getState().hosts
          acceptSnapshot(hosts)
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
          const active = useSessionsStore.getState().activeSessionId
          const remote = active ? sessionHostLane(active) : null
          if (remote?.lane && remote.lane.attention > remote.lane.read && document.hasFocus())
            void window.phosphor
              .invoke('hosts:markRead', remote.hostId, remote.lane.laneId)
              .catch(() => undefined)
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
  const offResources = attachHostResourceChanges()
  reportFocus()
  const offChanged = window.phosphor.onHostsChanged(() => void refresh())
  const offAttention = window.phosphor.onHostAttention((event) => {
    void refresh()
    const { live } = useSessionsStore.getState()
    const adopted = Object.values(live).find(
      (entry) =>
        entry.target?.kind === 'remote' &&
        entry.target.hostId === event.hostId &&
        entry.laneId === event.laneId,
    )
    void import('@/features/sessions/laneNotices').then(({ noticeHostAttention }) => {
      if (active)
        noticeHostAttention(event, adopted?.phosphorId, () =>
          openRemoteLane(event.hostId, event.laneId),
        )
    })
  })
  const offOpen = window.phosphor.onHostOpenLane(
    ({ hostId, laneId }) => void openRemoteLane(hostId, laneId),
  )
  const onFocus = (): void => void refresh()
  window.addEventListener('focus', onFocus)
  bindHostsSnapshotRead(refresh)
  void refresh()
  return () => {
    active = false
    invalidateRemoteArtifactReads()
    offFocus()
    offResources()
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
