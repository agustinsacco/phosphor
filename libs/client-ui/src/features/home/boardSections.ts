import type { HostLaneView } from '@shared/ipc'
import type { LocalLane } from '@/features/machines/LocalLanePreview'

/** How much a lane wants you now: a question or a failure, a turn in flight, or nothing. */
export type LaneUrgency = 'needs-you' | 'working' | 'idle'

interface BoardLaneBase {
  key: string
  /** Machine and folder, for rows that mix both: "bee2 · phosphor". */
  where: string
  /** Epoch ms of the lane's last activity; newest first within a section. */
  updatedAt: number
  urgency: LaneUrgency
}

/** One lane on the board, from This Mac or a Host, with the row that draws it. */
export type BoardLane =
  | (BoardLaneBase & { kind: 'host'; hostId: string; lane: HostLaneView; ready: boolean })
  | (BoardLaneBase & { kind: 'local'; lane: LocalLane })

export interface HomeSections {
  needsYou: BoardLane[]
  working: BoardLane[]
  recent: BoardLane[]
}

/** The lanes Recent shows: enough to pick up where you were, not the whole history. */
export const RECENT_LANES = 8

/**
 * A Host lane's urgency from its snapshot. A Host that is not ready reports nothing in
 * flight: its last-known activity is history (as `hostTasks` treats it).
 */
export function hostLaneUrgency(lane: HostLaneView, ready: boolean): LaneUrgency {
  if (!ready) return 'idle'
  if (lane.activity === 'needs-input' || lane.activity === 'failed') return 'needs-you'
  return lane.activity === 'working' ? 'working' : 'idle'
}

/** Parses an ISO time; an unknown time sorts last. */
export function laneTime(iso: string | undefined): number {
  const parsed = iso ? Date.parse(iso) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** Every lane on every machine, in the order a person should look at them. */
export function homeSections(
  lanes: readonly BoardLane[],
  recentLimit = RECENT_LANES,
): HomeSections {
  const newest = [...lanes].sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    needsYou: newest.filter((lane) => lane.urgency === 'needs-you'),
    working: newest.filter((lane) => lane.urgency === 'working'),
    recent: newest.filter((lane) => lane.urgency === 'idle').slice(0, recentLimit),
  }
}
