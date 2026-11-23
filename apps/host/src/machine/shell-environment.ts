import type { HostReleaseFeature } from '@phosphor/shared/host-release'

/** The login shell's environment for a local-mode daemon's lanes. Not built yet: null. */
export function createShellEnvironment(): null {
  return null
}

/** What this service adds to `phosphor version --json` once it exists. */
export const FEATURE: HostReleaseFeature | null = null
