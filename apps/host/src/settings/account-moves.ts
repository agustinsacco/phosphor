import { lstat } from 'node:fs/promises'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import type { HostClaudeAccounts } from '../providers/accounts'
import type { HostRuntime } from '../session/runtime'
import type { HostStore } from '../lanes/store'
import type { createRuntimeLanes } from '../lanes/runtime-host'

/** Explicit, fenced restart. A failed/revoked move leaves the lane stopped, never
 * silently restarted on its old credential. Metadata and spawn recheck authority. */
export function createAccountMoves(options: {
  accounts: Pick<
    HostClaudeAccounts,
    'withAuthorization' | 'loadAccounts' | 'status' | 'bindSession'
  >
  runtime: Pick<HostRuntime, 'withAuthorization'>
  store: Pick<HostStore, 'getLane'>
  binding: Pick<ReturnType<typeof createRuntimeLanes>, 'stopLane' | 'resumeLane'>
}) {
  return (laneId: string, accountId: string, authorized: () => boolean): Promise<void> =>
    options.accounts.withAuthorization(authorized, () =>
      options.runtime.withAuthorization(authorized, async () => {
        if (!authorized()) throw new Error('forbidden')
        const account = (await options.accounts.loadAccounts()).accounts.find(
          (account) => account.id === accountId,
        )
        if (!account) throw new Error('unknown-account')
        const status = await options.accounts.status(undefined, claudeAccountEnv(account))
        if (!status.auth.ok || !status.auth.loggedIn) throw new Error('account-not-ready')
        let lane = options.store.getLane(laneId)
        if (!lane || lane.removedAt !== null || lane.model?.provider !== 'pi-claude-cli')
          throw new Error('unsupported')
        if (!lane.sessionFile || !(await lstat(lane.sessionFile)).isFile())
          throw new Error('first-prompt-required')
        if (!authorized()) throw new Error('forbidden')
        await options.binding.stopLane(laneId, authorized)
        lane = options.store.getLane(laneId)
        if (
          !authorized() ||
          !lane ||
          lane.removedAt !== null ||
          lane.model?.provider !== 'pi-claude-cli' ||
          !lane.sessionFile ||
          !(await lstat(lane.sessionFile)).isFile()
        )
          throw new Error('unavailable')
        await options.accounts.bindSession(lane.sessionFile, accountId)
        if (!authorized()) throw new Error('forbidden')
        await options.binding.resumeLane(lane)
      }),
    )
}
