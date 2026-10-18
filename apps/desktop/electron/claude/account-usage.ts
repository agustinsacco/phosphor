import { mkdirSync } from 'node:fs'
import type {
  ClaudeAccount,
  ClaudeAccountPrefs,
  ClaudeAccountView,
  ClaudeAccountsResult,
} from '@shared/models'
import { getClaudeAccountPrefs } from '../store'
import { claudeStatus } from '../pi/packages'
import { cachedUsageSnapshot, fetchUsageSnapshot } from './usage'
import { backfillOrgIds, usageConfigDir } from './account-storage'
import {
  claudeAccountEnv,
  cooldownFromUsage,
  reconcileAuthIdentity,
  usageProbeEnv,
} from './routing'

/** Env for one account's `/usage` probe; see `usageProbeEnv`. */
export function accountUsageEnv(account: ClaudeAccount): Record<string, string> {
  const dir = usageConfigDir(account.id)
  mkdirSync(dir, { recursive: true })
  return usageProbeEnv(account, dir)
}

interface AccountUsagePorts {
  loadAccounts: (claudeOverride?: string) => Promise<ClaudeAccountPrefs>
  save: (prefs: ClaudeAccountPrefs) => ClaudeAccountPrefs
}

/** Bind usage projections without importing the account lifecycle facade. */
export function createAccountUsage({ loadAccounts, save }: AccountUsagePorts) {
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
          extraEnv: accountUsageEnv(account),
          ...(claudeOverride ? { claudeOverride } : {}),
        }).catch(() => null)
        if (!result?.ok) return null
        return { id: account.id, until: cooldownFromUsage(result.snapshot.windows, now) }
      }),
    )
    const latest = backfillOrgIds(getClaudeAccountPrefs())
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

  return { refreshCooldowns, accountViews }
}
