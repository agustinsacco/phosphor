import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ClaudeAccountPrefs } from '@shared/models'
import { setClaudeAccountPrefs } from '../store'
import { orgIdToBackfill, pruneCooldowns } from './routing'

/** Where per-account credential directories live. Stable across launches. */
export function accountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

/** The private CLI config dir an account's `/usage` probe runs under. */
export function usageConfigDir(accountId: string): string {
  return join(accountsRoot(), 'usage', accountId)
}

/**
 * Record the org id an account's own probe learned, when it has none.
 *
 * The seeded default account never recorded one, so its sessions sent
 * whichever org last signed in (`~/.claude.json` is shared). The probe dir's
 * `oauthAccount` comes from that account's own token, so it is the right one.
 */
export function backfillOrgIds(prefs: ClaudeAccountPrefs): ClaudeAccountPrefs {
  let changed = false
  const accounts = prefs.accounts.map((account) => {
    let identity: { emailAddress?: unknown; organizationUuid?: unknown } | undefined
    try {
      const raw = readFileSync(join(usageConfigDir(account.id), '.claude.json'), 'utf8')
      identity = (JSON.parse(raw) as { oauthAccount?: typeof identity }).oauthAccount
    } catch {
      return account
    }
    const orgId = orgIdToBackfill(account, identity)
    if (!orgId) return account
    changed = true
    return { ...account, orgId }
  })
  return changed ? { ...prefs, accounts } : prefs
}

/** Prefs with expired cooldowns and dead session bindings dropped. */
export function tidy(prefs: ClaudeAccountPrefs, nowMs: number): ClaudeAccountPrefs {
  const ids = new Set(prefs.accounts.map((a) => a.id))
  return {
    ...prefs,
    cooldowns: pruneCooldowns(prefs.cooldowns, ids, nowMs),
    bindings: Object.fromEntries(
      Object.entries(prefs.bindings).filter(([path, id]) => ids.has(id) && existsSync(path)),
    ),
  }
}

export function save(prefs: ClaudeAccountPrefs): ClaudeAccountPrefs {
  const tidied = tidy(prefs, Date.now())
  setClaudeAccountPrefs(tidied)
  return tidied
}
