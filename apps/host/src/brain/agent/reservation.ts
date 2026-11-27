import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createReservedLane, type ReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'

/**
 * Brain Agent's reservation: `<real state>/brain/Brain`, the same folder as `hostBrainLaneFolder`
 * by real path. Made before the runtime so the curator contribution and the runtime share the one
 * object; the folder itself is created only for the lane's first turn.
 */
export function hostBrainAgentReservation(stateDirectory: string): ReservedLane {
  return createReservedLane(
    'brain-agent',
    join(realpathSync.native(stateDirectory), 'brain', 'Brain'),
  )
}
