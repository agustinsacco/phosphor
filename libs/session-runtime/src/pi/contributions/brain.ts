import type { SpawnContribution, SpawnInputs } from '../spawn-contributions'

export type BrainResources = () => Promise<Pick<SpawnInputs, 'extensions' | 'skills'> | undefined>

/** Recall preferences select resources, never environment or credentials. */
export function brainContribution(resources: BrainResources): SpawnContribution {
  return {
    name: 'brain',
    async spawn() {
      const launch = await resources()
      if (launch) return { extensions: launch.extensions, skills: launch.skills }
      return undefined
    },
  }
}
