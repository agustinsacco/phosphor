import { create } from 'zustand'
import type { LiveSessionInfo } from '@shared/models'
import { remoteLaneKey } from '@shared/remote-host'
import { refreshRemoteArtifacts } from '@/features/artifacts/remoteArtifactRefresh'
import { warmOpenedLane } from '@/platform/serviceLaneControl'
import { useExtensionUiStore } from './extensionUi'
import { refreshHostsSnapshot } from './hostsSnapshotRead'
import { useLayoutStore } from './layout'
import { useSessionsStore } from './sessions'

/**
 * Host lanes still opening, by `remoteLaneKey`: through adoption, bootstrap
 * and any snapshot refresh. Their rows say so even after the user goes elsewhere.
 */
export const useHostLaneOpensStore = create<{ inFlight: Record<string, true> }>(() => ({
  inFlight: {},
}))

export function useHostLaneOpenInFlight(hostId: string, laneId: string): boolean {
  return useHostLaneOpensStore((s) => s.inFlight[remoteLaneKey(hostId, laneId)] === true)
}

const running = new Map<string, Promise<string>>()

/**
 * Opens a Host lane and adopts its handle, once per lane at a time: a click
 * back to a lane whose open is running waits on that open rather than
 * starting a second one. A finished open, failed or not, is forgotten, so the
 * next click starts afresh. Resolves to the adopted session id.
 */
export function openHostLane(
  target: { hostId: string; laneId: string },
  /** A service or warm-on-open Host's lane snapshot lands before its debounced notification. */
  refreshSnapshot: boolean,
): Promise<string> {
  const key = remoteLaneKey(target.hostId, target.laneId)
  const existing = running.get(key)
  if (existing) return existing
  const open = adoptHostLane(target, refreshSnapshot).finally(() => {
    running.delete(key)
    useHostLaneOpensStore.setState((s) => {
      const { [key]: _done, ...inFlight } = s.inFlight
      return { inFlight }
    })
  })
  running.set(key, open)
  useHostLaneOpensStore.setState((s) => ({ inFlight: { ...s.inFlight, [key]: true } }))
  return open
}

/**
 * Opens a Host lane and adopts its handle in place: no navigation, no opening
 * state, no once-per-lane flight. `openHostLane` wraps it for navigation; a
 * lane menu action that needs the lane's session calls it directly.
 */
export async function adoptHostLane(
  { hostId, laneId }: { hostId: string; laneId: string },
  refreshSnapshot: boolean,
): Promise<string> {
  const info = await window.phosphor.invoke('hosts:openLane', hostId, laneId)
  await useSessionsStore
    .getState()
    .adoptSession(info.sessionId, info.workspacePath, undefined, info)
  if (refreshSnapshot) await refreshHostsSnapshot()
  return info.sessionId
}

/** This live session is the one this client holds for that Host lane. */
export function holdsHostLane(
  entry: { target?: LiveSessionInfo['target']; laneId?: string } | undefined,
  lane: { hostId: string; laneId: string },
): boolean {
  return (
    entry?.target?.kind === 'remote' &&
    entry.target.hostId === lane.hostId &&
    entry.laneId === lane.laneId
  )
}

/**
 * Claims the screen for a Host lane before it opens: no page in the way, the
 * lane opening. A lane this client already holds switches without the opening
 * view, so moving between open lanes never flashes it.
 */
export function beginHostLaneOpening(lane: { hostId: string; laneId: string }, title: string) {
  const sessions = useSessionsStore.getState()
  // Adoption publishes the handle before its transcript and state are ready.
  const held =
    !running.has(remoteLaneKey(lane.hostId, lane.laneId)) &&
    Object.values(sessions.live).some((entry) => holdsHostLane(entry, lane))
  if (held) return sessions.claimNav()
  useLayoutStore.getState().setPage(null)
  return sessions.beginOpening({
    workspacePath: remoteLaneKey(lane.hostId, lane.laneId),
    title,
    reason: 'open',
    lane,
  })
}

/** Ends this navigation's opening view: gone, or kept to say why its Host lane failed. */
export function settleOpening(nav: number, failure?: string): void {
  useSessionsStore.setState((s) =>
    s.opening?.nav !== nav
      ? {}
      : { opening: failure && s.opening.lane ? { ...s.opening, failure } : null },
  )
}

/** Leave only the navigation this caller owns; its open can still finish in the background. */
export function releaseHostLaneNav(nav: number): void {
  const sessions = useSessionsStore.getState()
  if (sessions.navSeq === nav) sessions.claimNav()
}

export const isActiveLane = (id: string): boolean =>
  useSessionsStore.getState().activeSessionId === id && useLayoutStore.getState().page === null

export async function prepareOpenedLane(sessionId: string): Promise<void> {
  warmOpenedLane(
    sessionId,
    () => isActiveLane(sessionId),
    (message) => useExtensionUiStore.getState().pushToast(message, 'error'),
  )
  await refreshRemoteArtifacts(sessionId)
}
