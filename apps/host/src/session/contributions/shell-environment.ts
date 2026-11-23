import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import { AMBIENT_NAMES } from '../../machine/environment'
import type { HostShellEnvironment } from '../../machine/shell-environment'

export function shellEnvironmentContribution(shell: HostShellEnvironment): SpawnContribution {
  return {
    name: 'shell-environment',
    spawn() {
      const env = shell.additions()
      // Only PATH and explicitly passed ambient authority take precedence over the daemon.
      // Other names fill gaps; they cannot replace a selected Claude account or lane policy.
      const overrides = Object.fromEntries(
        Object.entries(env).filter(([name]) => name === 'PATH' || AMBIENT_NAMES.has(name)),
      )
      return { envDefaults: env, env: overrides }
    },
  }
}
