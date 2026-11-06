import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'

/** A Host lane's session: its Host and lane, each undefined until the Host lists it. */
export interface SessionHostLane {
  hostId: string
  laneId: string | undefined
  host: HostConnectionView | undefined
  lane: HostLaneView | undefined
}

/** Null for This Mac's session; otherwise the lane on `host` the session is bound to. */
export function hostLaneOf(
  entry: Pick<LiveSessionInfo, 'target' | 'laneId'> | undefined,
  host: HostConnectionView | undefined,
): SessionHostLane | null {
  if (entry?.target?.kind !== 'remote') return null
  const lane = host?.lanes.find((item) => item.laneId === entry.laneId)
  return { hostId: entry.target.hostId, laneId: entry.laneId, host, lane }
}
