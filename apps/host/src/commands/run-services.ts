import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import { createLanePauses, FEATURE as PAUSE_FEATURE } from '../lanes/pause'
import { type HostShellEnvironment, FEATURE as SHELL_FEATURE } from '../machine/shell-environment'
import { createOpsService, FEATURE as OPS_FEATURE } from '../ops/service'
import { createReach, FEATURE as REACH_FEATURE } from '../reach'
import { createAppServices, FEATURE as APP_SERVICES_FEATURE } from '../session/app-services'
import { createHeadroomService, FEATURE as HEADROOM_FEATURE } from '../session/headroom'

/** What `phosphor version --json` reports this build can do: every built service's feature. */
export function runServiceFeatures(): readonly HostReleaseFeature[] {
  return [
    OPS_FEATURE,
    REACH_FEATURE,
    HEADROOM_FEATURE,
    APP_SERVICES_FEATURE,
    PAUSE_FEATURE,
    SHELL_FEATURE,
  ].filter((feature) => feature !== null)
}

/** The machine services `run` starts once, beside the lane service. Each is null until built. */
export function createRunServices(shellEnvironment?: HostShellEnvironment) {
  return {
    ops: createOpsService(),
    reach: createReach(),
    headroom: createHeadroomService(),
    appServices: createAppServices(),
    pauses: createLanePauses(),
    shellEnvironment: shellEnvironment ?? null,
  }
}

export type RunServices = ReturnType<typeof createRunServices>
