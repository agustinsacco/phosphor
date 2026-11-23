import type { SpawnContribution, SpawnInputs } from '../spawn-contributions'

/** Brain's resources for a lane in `workspacePath` (resolved), or undefined when off. */
export type BrainResources = (
  workspacePath: string,
) => Promise<Pick<SpawnInputs, 'extensions' | 'skills'> | undefined>

/** Recall preferences select resources, never environment or credentials. */
export function brainContribution(resources: BrainResources): SpawnContribution {
  return {
    name: 'brain',
    async spawn(_execution, { options }) {
      const launch = await resources(options.workspacePath)
      if (launch) return { extensions: launch.extensions, skills: launch.skills }
      return undefined
    },
  }
}
