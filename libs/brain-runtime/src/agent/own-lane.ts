import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { isWithinFolder } from '@phosphor/shared/paths'

export const BRAIN_OWN_LANE_REFUSAL = 'Brain never reads its own lane.'

/**
 * Whether a lane ran in Brain Agent's folder or below it. Brain never reads those lanes: their
 * memories would cite Brain's own decisions. `folder` is a real path; the cwd is compared as
 * written and, when it still exists, resolved.
 */
export function isBrainOwnLane(
  cwd: string | null | undefined,
  folder: string | undefined,
): boolean {
  if (!cwd || !folder) return false
  const written = resolve(cwd)
  if (isWithinFolder(written, folder)) return true
  try {
    return isWithinFolder(realpathSync.native(written), folder)
  } catch {
    return false
  }
}
