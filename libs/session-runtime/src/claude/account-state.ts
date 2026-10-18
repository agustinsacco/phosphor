import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeAccount, ClaudeAccountPrefs } from '@shared/models'
import type { ClaudeAccountPorts } from './account-ports'
import { orgIdToBackfill, pruneCooldowns } from './routing'

/** Prefs with expired cooldowns and dead session bindings dropped. */
function tidy(prefs: ClaudeAccountPrefs, nowMs: number): ClaudeAccountPrefs {
  const ids = new Set(prefs.accounts.map((a) => a.id))
  return {
    ...prefs,
    cooldowns: pruneCooldowns(prefs.cooldowns, ids, nowMs),
    bindings: Object.fromEntries(
      Object.entries(prefs.bindings).filter(([path, id]) => ids.has(id) && existsSync(path)),
    ),
  }
}

/**
 * Record the org id an account's own probe learned, when it has none.
 *
 * The seeded default account never recorded one, so its sessions sent
 * whichever org last signed in (`~/.claude.json` is shared). The probe dir's
 * `oauthAccount` comes from that account's own token, so it is the right one.
 */
function backfillOrgIds(
  usageConfigDir: (accountId: string) => string,
  prefs: ClaudeAccountPrefs,
): ClaudeAccountPrefs {
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

/** Machine-local persistence, shared by account mutations and usage projections. */
export function createAccountState(input: ClaudeAccountPorts) {
  // Capture operations once, but keep Desktop's redirected userData root lazy.
  const ports: ClaudeAccountPorts = {
    get root() {
      return input.root
    },
    read: input.read,
    write: input.write,
    status: input.status,
    logout: input.logout,
    cachedUsage: input.cachedUsage,
    clearUsage: input.clearUsage,
    fetchUsage: input.fetchUsage,
  }
  const read = ports.read
  const write = ports.write
  const status = ports.status

  function save(prefs: ClaudeAccountPrefs): ClaudeAccountPrefs {
    const tidied = tidy(prefs, Date.now())
    write(tidied)
    return tidied
  }

  /**
   * Accounts as stored, seeding the existing login as account one on first read.
   * Without the seed a working terminal login would be absent from the UI.
   */
  async function loadAccounts(claudeOverride?: string): Promise<ClaudeAccountPrefs> {
    const stored = read()
    if (stored.accounts.length > 0) return stored

    const checked = await status(claudeOverride).catch(() => null)
    if (checked?.auth.loggedIn !== true) return stored
    const seeded: ClaudeAccount = {
      id: 'default',
      label: checked.auth.email ?? 'Claude account',
      email: checked.auth.email,
      plan: checked.auth.plan,
      organization: checked.auth.organization,
      orgId: checked.auth.orgId,
      credentialDir: null,
      addedAt: Date.now(),
    }
    return save({ ...stored, accounts: [seeded], pinnedId: seeded.id })
  }

  /** The private CLI config dir an account's `/usage` probe runs under. */
  function usageConfigDir(accountId: string): string {
    return join(ports.root, 'usage', accountId)
  }

  return {
    ports,
    read,
    save,
    loadAccounts,
    usageConfigDir,
    backfillOrgIds: backfillOrgIds.bind(null, usageConfigDir),
  }
}

export type AccountState = ReturnType<typeof createAccountState>
