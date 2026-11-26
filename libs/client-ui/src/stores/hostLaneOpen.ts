import { create } from 'zustand'
import { remoteLaneKey } from '@shared/remote-host'
import { refreshRemoteArtifacts } from '@/features/artifacts/remoteArtifactRefresh'
import { warmOpenedLane } from '@/platform/serviceLaneControl'
import { useExtensionUiStore } from './extensionUi'
import { refreshHostsSnapshot } from './hostsSnapshotRead'
import { useLayoutStore } from './layout'
import { useSessionsStore } from './sessions'

/**
 * Host lanes whose `hosts:openLane` is running, by `remoteLaneKey`. An open
 * keeps going after the user clicks elsewhere, so its row says so even when it
 * is not the selection.
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
  const open = adopt(target, refreshSnapshot).finally(() => {
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

async function adopt(
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

/** Claims the screen for a Host lane before it opens: no page in the way, the lane opening. */
export function beginHostLaneOpening(lane: { hostId: string; laneId: string }, title: string) {
  useLayoutStore.getState().setPage(null)
  return useSessionsStore.getState().beginOpening({
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
