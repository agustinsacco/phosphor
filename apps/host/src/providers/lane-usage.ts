import type { ClaudeAccountPrefs, ClaudeUsageSnapshotResult } from '@phosphor/shared/models'
import type { HostClaudeAccounts } from './accounts'

/** A client's Refresh still cannot run the CLI more often than this per account. */
export const USAGE_FORCE_FLOOR_MS = 10_000

/**
 * Plan usage for the Claude account a lane bills, read with that account's own
 * `claude -p /usage` probe and the shared per-account cache. Parsed on this
 * machine, so reset stamps use its timezone. Only labels, percentages and reset
 * times leave the Host: the free-text "contributing" block is dropped.
 *
 * A lane with no account (or none named) reads the primary account, the same
 * one `primaryAccount` reports: pinned, else first, else the CLI's default login.
 */
export function createLaneUsage(options: {
  accounts: Pick<HostClaudeAccounts, 'loadAccounts' | 'accountUsageEnv' | 'usage'>
  accountForLane: (laneId: string, prefs: ClaudeAccountPrefs) => string | undefined
}) {
  return async (
    laneId: string | undefined,
    force: boolean,
    nowMs: number = Date.now(),
  ): Promise<ClaudeUsageSnapshotResult> => {
    const prefs = await options.accounts.loadAccounts()
    const bound = laneId ? options.accountForLane(laneId, prefs) : undefined
    const pinned = prefs.pinnedId ? prefs.accounts.find((a) => a.id === prefs.pinnedId) : undefined
    const account =
      prefs.accounts.find((a) => a.id === bound) ?? pinned ?? prefs.accounts[0] ?? null
    const { usage } = options.accounts
    const recent = usage.cachedUsageSnapshot(account?.id ?? 'default', nowMs)
    const result = await usage.fetchUsageSnapshot({
      ...(account
        ? { cacheKey: account.id, extraEnv: options.accounts.accountUsageEnv(account) }
        : {}),
      force: force && !(recent && nowMs - recent.fetchedAt < USAGE_FORCE_FLOOR_MS),
      nowMs,
    })
    return result.ok ? { ok: true, snapshot: { ...result.snapshot, contributing: null } } : result
  }
}
