import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import { createBrainContribution } from './brain'
import { createDirectivesContribution } from './directives'
import { createHeadroomContribution } from './headroom'
import { createOpsContribution } from './ops'

/** the Host's spawn contributions in argv order. Each feature fills only its own file. */
export function hostSpawnContributions(): readonly SpawnContribution[] {
  return [
    createOpsContribution(),
    createDirectivesContribution(),
    createHeadroomContribution(),
    createBrainContribution(),
  ].filter((contribution) => contribution !== null)
}
