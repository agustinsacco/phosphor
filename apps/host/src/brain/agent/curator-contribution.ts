import type { BrainCuratorLaunch } from '@phosphor/brain-runtime/types'
import type { ReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { BrainAgentLaunchProfile } from './profile'

/**
 * Brain Agent's curator tools and its private bridge connection, for exactly one spawn: the one
 * whose execution carries this Host's reserved Brain Agent lane, in that lane's folder. The
 * check is the reservation object itself, so a lane in the same folder, a copied or forked
 * transcript, or any request field gets nothing. The connection travels as the typed
 * `brainConnection` spawn field, never env, and `brain-curator.mjs` removes it on load.
 *
 * A spawn in the interactive profile also loads the tool guard, even with Brain off: the
 * conversation proves it loaded before a person's message reaches the process.
 */
export function createBrainCuratorContribution(
  lane: ReservedLane,
  launch: () => Promise<BrainCuratorLaunch | undefined>,
  profile: BrainAgentLaunchProfile,
): SpawnContribution {
  return {
    name: 'brain-curator',
    async spawn(execution, { options }) {
      if (execution.reserved !== lane || options.workspacePath !== lane.folder) return undefined
      const guard = profile.next === 'interactive' && profile.guard ? [profile.guard] : []
      const resources = await launch()
      if (!resources) return guard.length ? { extensions: guard } : undefined
      return {
        extensions: [...guard, ...resources.extensions],
        skills: resources.skills,
        brainConnection: resources.connection,
      }
    },
  }
}
