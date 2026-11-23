import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'

/**
 * Brain recall for the Host's lanes. Null until that
 * feature lands, so spawns stay unchanged.
 */
export function createBrainContribution(): SpawnContribution | null {
  return null
}
