import type { DaemonHeadroom } from '../headroom'
import type { HostShellEnvironment } from '../../machine/shell-environment'
import type { HostLog } from '../../machine/log'
import { shellEnvironmentContribution } from './shell-environment'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import { createBrainContribution } from './brain'
import { createDirectivesContribution } from './directives'
import { createHeadroomContribution } from './headroom'
import { createOpsContribution, type HostOpsLanePorts } from './ops'

/** the Host's spawn contributions in argv order. Each feature fills only its own file. */
export function hostSpawnContributions(
  shell: HostShellEnvironment | undefined,
  log: HostLog,
  brain?: Parameters<typeof createBrainContribution>[0],
  headroom?: DaemonHeadroom,
  ops?: HostOpsLanePorts,
  curator?: SpawnContribution,
): readonly SpawnContribution[] {
  shell?.bindLog(log)
  return [
    shell ? shellEnvironmentContribution(shell) : null,
    createOpsContribution(ops),
    createDirectivesContribution(),
    createHeadroomContribution(headroom),
    brain ? createBrainContribution(brain) : null,
    curator ?? null,
  ].filter((contribution) => contribution !== null)
}
