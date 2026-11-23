import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'

/**
 * The directives base for the Host's lanes. Null until that
 * feature lands, so spawns stay unchanged.
 */
export function createDirectivesContribution(): SpawnContribution | null {
  return null
}
