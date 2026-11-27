import { setPriority } from 'node:os'
import type { RuntimeLog } from '../file-log'

/** nice 10: below interactive apps, above the nice 19 of true batch work. */
export const LOW_LANE_PRIORITY = 10

/**
 * Lower a new lane's CPU priority when the owner's setting asks for it. What
 * the lane starts later (bash, npm, test runners, the provider CLI) inherits
 * it, so a lane running a full test suite cannot starve the desktop or the
 * user's other apps, while on an idle machine it runs as fast as before.
 * Raising a priority back needs privileges, so a running lane keeps what it
 * started with: the setting applies to the next lane.
 */
export function applyLanePriority(pid: number | undefined, low: boolean, log: RuntimeLog): void {
  if (!low || pid === undefined) return
  try {
    setPriority(pid, LOW_LANE_PRIORITY)
  } catch (error) {
    log('pi', 'lane priority not applied', { pid, error: String(error) })
  }
}
