import type { BrainLanes } from '@phosphor/brain-runtime/types'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import { claudeProviderSpawnEnv } from '@phosphor/session-runtime/pi/provider-detect'
import type { HostClaudeAccounts } from '../providers/accounts'

export interface HostBrainLanePorts {
  /** pi as doctor resolved it, and its environment: the same the Host's lanes start with. */
  pi: { binaryPath: string; prefixArgs: string[] }
  env: Record<string, string>
  /** Whether a live lane on this transcript is working. Absent runtime: wait. */
  busy(sessionPath: string): boolean | undefined
  accounts?: Pick<HostClaudeAccounts, 'accountForSpawn'>
}

/**
 * Brain's view of the Host's lanes. A private reader call starts the lane's own pi with the
 * lane's own account: the transcript's bound account when it has one, chosen as a resumed lane
 * would be. Account metadata that cannot be read fails the read instead of billing the default.
 * No context-compression environment: quotes must match the lane's own text.
 */
export function createHostBrainLanes(ports: HostBrainLanePorts): BrainLanes {
  return {
    busy: (sessionPath) => ports.busy(sessionPath) ?? true,
    async launch(sessionPath) {
      const account = await ports.accounts?.accountForSpawn({ sessionPath })
      return {
        binaryPath: ports.pi.binaryPath,
        prefixArgs: [...ports.pi.prefixArgs],
        env: { ...ports.env, ...claudeProviderSpawnEnv(), ...claudeAccountEnv(account ?? null) },
      }
    },
  }
}
