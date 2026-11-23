import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'

/**
 * The lane's agent-control tool and op-channel marker for Desktop's lanes. Null until that
 * feature lands, so spawns stay unchanged.
 */
export function createOpsContribution(): SpawnContribution | null {
  return null
}
