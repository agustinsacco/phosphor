import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'
import type { LaneFacts } from '@phosphor/session-runtime/ops/types'
import type { HostStore } from '../../lanes/store'
import { laneIdOfRef } from './lane-target'

export interface LaneSelfUndoPorts {
  resolve(ref: string): LaneFacts | null
  readonly store: Pick<HostStore, 'getLane'>
}

/**
 * Undo's precondition for the lane's own state: the lane still has the title, pin or
 * marker the agent set. Any other op, or a lane that is gone, is not current,
 * so its Undo is refused.
 */
export function laneSelfUndoCurrent(ports: LaneSelfUndoPorts): UndoPorts['isCurrent'] {
  return async (entry) => {
    const args = entry.undoRecord.forward
    const lane = entry.target ? ports.resolve(entry.target) : null
    const laneId = lane ? laneIdOfRef(lane.ref) : undefined
    if (!args || !lane || !laneId) return false
    if (entry.op === 'lane.rename') return args.name === lane.title
    const stored = ports.store.getLane(laneId)
    if (!stored) return false
    if (entry.op === 'lane.pin') return args.on === (stored.pinned === true)
    if (entry.op === 'lane.marker') return args.marker === stored.marker
    return false
  }
}

/** The lane-self writes whose Undo `laneSelfUndoCurrent` checks. */
export const LANE_SELF_UNDO_OPS: ReadonlySet<string> = new Set([
  'lane.rename',
  'lane.pin',
  'lane.marker',
])
