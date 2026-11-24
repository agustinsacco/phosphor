import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import { LOCAL_SERVICE_FEATURES } from '@phosphor/session-runtime/host-install/release-source'
import { createLanePauses, FEATURE as PAUSE_FEATURE, type LanePausePorts } from '../lanes/pause'
import { type HostShellEnvironment, FEATURE as SHELL_FEATURE } from '../machine/shell-environment'
import { FEATURE as OPS_FEATURE } from '../ops/service'
import { createReach, FEATURE as REACH_FEATURE } from '../reach'
import { type AppServices, FEATURE as APP_SERVICES_FEATURE } from '../session/app-services'
import { type DaemonHeadroom, FEATURE as HEADROOM_FEATURE } from '../session/headroom'

/** What `phosphor version --json` reports this build can do: every built service's feature. */
export function runServiceFeatures(): readonly HostReleaseFeature[] {
  return [
    OPS_FEATURE,
    REACH_FEATURE,
    HEADROOM_FEATURE,
    APP_SERVICES_FEATURE,
    PAUSE_FEATURE,
    SHELL_FEATURE,
  ]
    .filter((feature) => feature !== null)
    .concat(MACHINE_FEATURES)
}

/**
 * The daemon-first machine, built into every Host: local mode and its owner
 * socket (what Desktop's installer and launch gate require), the owner lock,
 * and Desktop's one-time migration import.
 */
const MACHINE_FEATURES: readonly HostReleaseFeature[] = [
  ...LOCAL_SERVICE_FEATURES,
  'owner-lock',
  'migrate-v1',
]

/** The machine services `run` starts once, beside the lane service. Each is null until built. */
export function createRunServices(
  shellEnvironment?: HostShellEnvironment,
  appServices?: AppServices,
  headroom?: DaemonHeadroom,
  pauses?: LanePausePorts,
) {
  return {
    reach: createReach(),
    headroom: headroom ?? null,
    appServices: appServices ?? null,
    pauses: pauses ? createLanePauses(pauses) : null,
    shellEnvironment: shellEnvironment ?? null,
  }
}

export type RunServices = ReturnType<typeof createRunServices>
