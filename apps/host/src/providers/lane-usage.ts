import type {
  ClaudeAccountPrefs,
  ClaudeUsageSnapshot,
  ClaudeUsageSnapshotResult,
} from '@phosphor/shared/models'
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
 *
 * When a probe fails, the slot's last reading is served as `stale` only while
 * `claude auth status` still reports the login that reading was taken under.
 * A login is a separate process the Host is never told about, so the slot id
 * alone cannot say whose quota a reading is.
 */
export function createLaneUsage(options: {
  accounts: Pick<HostClaudeAccounts, 'loadAccounts' | 'accountUsageEnv' | 'usage' | 'status'>
  accountForLane: (laneId: string, prefs: ClaudeAccountPrefs) => string | undefined
}) {
  const known = new Map<string, { snapshot: ClaudeUsageSnapshot; login: string }>()
  /** Who the slot is signed in as, or null when that is unknown or nobody. */
  const loginOf = async (env: Record<string, string> | undefined) => {
    const { auth } = await options.accounts.status(undefined, env).catch(() => ({ auth: null }))
    if (!auth?.ok || !auth.loggedIn || !(auth.email ?? auth.orgId)) return null
    return JSON.stringify([auth.email ?? null, auth.orgId ?? null])
  }
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
    const key = account?.id ?? 'default'
    for (const id of known.keys())
      if (id !== 'default' && !prefs.accounts.some((a) => a.id === id)) known.delete(id)
    const extraEnv = account ? options.accounts.accountUsageEnv(account) : undefined
    const recent = usage.cachedUsageSnapshot(key, nowMs)
    const reuse = !!recent && (!force || nowMs - recent.fetchedAt < USAGE_FORCE_FLOOR_MS)
    // Started beside the probe: a login that changes while it runs fences the reading out.
    const before = reuse ? null : loginOf(extraEnv)
    const result = await usage.fetchUsageSnapshot({
      ...(account ? { cacheKey: account.id, extraEnv } : {}),
      force: force && !reuse,
      nowMs,
    })
    if (result.ok) {
      if (before && known.get(key)?.snapshot !== result.snapshot) {
        const [start, end] = await Promise.all([before, loginOf(extraEnv)])
        if (start && start === end) known.set(key, { snapshot: result.snapshot, login: end })
        else known.delete(key)
      }
      return { ok: true, snapshot: { ...result.snapshot, contributing: null } }
    }
    const last = known.get(key)
    if (!last) return result
    if ((await (before ?? loginOf(extraEnv))) !== last.login) {
      known.delete(key)
      return result
    }
    return { ok: true, snapshot: { ...last.snapshot, contributing: null, stale: true } }
  }
}
