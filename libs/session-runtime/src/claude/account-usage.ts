import { mkdirSync } from 'node:fs'
import type { ClaudeAccount, ClaudeAccountView, ClaudeAccountsResult } from '@shared/models'
import type { AccountState } from './account-state'
import {
  claudeAccountEnv,
  cooldownFromUsage,
  reconcileAuthIdentity,
  usageProbeEnv,
} from './routing'

/** Env for one account's `/usage` probe; see `usageProbeEnv`. */
function accountUsageEnv(state: AccountState, account: ClaudeAccount): Record<string, string> {
  const dir = state.usageConfigDir(account.id)
  mkdirSync(dir, { recursive: true })
  return usageProbeEnv(account, dir)
}

/** Bind usage projections without importing the account lifecycle facade. */
export function createAccountUsage(state: AccountState) {
  const { loadAccounts, save, read, backfillOrgIds } = state
  const fetchUsageSnapshot = state.ports.fetchUsage
  const claudeStatus = state.ports.status
  const cachedUsageSnapshot = state.ports.cachedUsage
  const usageEnv = accountUsageEnv.bind(null, state)

  /**
   * Re-read every account's usage and turn "5-hour window at 100%" into a
   * cooldown. Fire-and-forget: one `claude -p /usage` per account, zero quota,
   * ~2s each, all in parallel, and a failure just leaves the old cooldown.
   */
  async function refreshCooldowns(claudeOverride?: string): Promise<void> {
    const prefs = await loadAccounts(claudeOverride)
    const now = Date.now()
    const results = await Promise.all(
      prefs.accounts.map(async (account) => {
        const result = await fetchUsageSnapshot({
          cacheKey: account.id,
          extraEnv: usageEnv(account),
          ...(claudeOverride ? { claudeOverride } : {}),
        }).catch(() => null)
        if (!result?.ok) return null
        return { id: account.id, until: cooldownFromUsage(result.snapshot.windows, now) }
      }),
    )
    const latest = backfillOrgIds(read())
    const cooldowns = { ...latest.cooldowns }
    for (const entry of results) {
      if (!entry) continue
      if (entry.until === null) delete cooldowns[entry.id]
      else cooldowns[entry.id] = entry.until
    }
    save({ ...latest, cooldowns })
  }

  /** Accounts plus their live auth state and whatever usage main already has. */
  async function accountViews(claudeOverride?: string): Promise<ClaudeAccountsResult> {
    const prefs = await loadAccounts(claudeOverride)
    const now = Date.now()
    const views: ClaudeAccountView[] = await Promise.all(
      prefs.accounts.map(async (account) => {
        const status = await claudeStatus(claudeOverride, claudeAccountEnv(account)).catch(
          () => null,
        )
        const cooldown = prefs.cooldowns[account.id]
        return {
          account,
          auth: status?.auth
            ? reconcileAuthIdentity(account, status.auth)
            : { ok: false, error: 'status check failed' },
          usage: cachedUsageSnapshot(account.id, now),
          cooldownUntil: cooldown !== undefined && cooldown > now ? cooldown : null,
        }
      }),
    )
    return { prefs, views }
  }

  return { accountUsageEnv: usageEnv, refreshCooldowns, accountViews }
}
