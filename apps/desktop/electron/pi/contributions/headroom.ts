import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'

/**
 * The Headroom relay socket for Desktop's lanes. Null until that
 * feature lands, so spawns stay unchanged.
 */
export function createHeadroomContribution(): SpawnContribution | null {
  return null
}
