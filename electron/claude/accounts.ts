/**
 * Several Claude Code logins side by side, and the routing over them.
 *
 * The CLI keeps one credential — but *which* one it keeps is a function of a
 * directory. From its own bundle (2.1.260):
 *
 *     var t5 = "-credentials"
 *     function fx(n = "") {
 *       let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *           t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
 *           r = e !== undefined ? e.normalize("NFC") : configDir(),
 *           c = t ? "" : `-${sha256(r).slice(0, 8)}`
 *       return `Claude Code${SUFFIX}${n}${c}`
 *     }
 *
 * So `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>` moves the keychain entry to
 * `Claude Code-credentials-<hash of dir>` and nothing else moves with it —
 * `claude auth status` under an isolated dir still reports
 * `projectsDirectory: ~/.claude/projects`. `CLAUDE_CONFIG_DIR` is the wrong
 * knob for this: it relocates projects, settings.json, skills and plugins too.
 *
 * pidex spawns one `pi` per session and pi-claude-cli spawns the CLI with
 * `{ ...process.env }`, so putting the variable on the pi spawn binds the whole
 * session — pi, the extension, and the parked CLI process — to one account.
 * That is why this feature needs no pi-claude-cli change at all.
 *
 * The first account is seeded with `credentialDir: null`, i.e. the CLI's own
 * default entry. Nothing migrates, and your terminal `claude` keeps sharing it.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type {
  ClaudeAccount,
  ClaudeAccountPrefs,
  ClaudeAccountView,
  ClaudeAccountsResult,
  ClaudeRoutingMode,
  ClaudeSessionAccount,
} from '@shared/models'
import { getClaudeAccountPrefs, setClaudeAccountPrefs } from '../store'
import { claudeStatus } from '../pi/packages'
import { logoutClaude } from '../pi/claude-login'
import { cachedUsageSnapshot, clearUsageCache, fetchUsageSnapshot } from './usage'
import {
  claudeAccountEnv,
  cooldownFromUsage,
  isCoolingDown,
  pruneCooldowns,
  selectAccount,
} from './routing'

export { claudeAccountEnv }

/** Where per-account credential directories live. Stable across launches. */
function accountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

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

function save(prefs: ClaudeAccountPrefs): ClaudeAccountPrefs {
  const tidied = tidy(prefs, Date.now())
  setClaudeAccountPrefs(tidied)
  return tidied
}

/**
 * Accounts as stored, seeding the existing login as account one on first read.
 *
 * Without the seed the list would start empty on an install that has been
 * signed in for months, and the tab would offer "Add account" next to a
 * working session — the routing would still be right (no accounts = no env =
 * the default credential), but the UI would be lying.
 */
export async function loadAccounts(claudeOverride?: string): Promise<ClaudeAccountPrefs> {
  const stored = getClaudeAccountPrefs()
  if (stored.accounts.length > 0) return stored

  const status = await claudeStatus(claudeOverride).catch(() => null)
  if (status?.auth.loggedIn !== true) return stored
  const seeded: ClaudeAccount = {
    id: 'default',
    label: status.auth.email ?? 'Claude account',
    email: status.auth.email,
    plan: status.auth.plan,
    organization: status.auth.organization,
    credentialDir: null,
    addedAt: Date.now(),
  }
  return save({ ...stored, accounts: [seeded], pinnedId: seeded.id })
}

/** The account a one-shot `pi -p` run (session naming, provider test) uses. */
export async function primaryAccount(claudeOverride?: string): Promise<ClaudeAccount | null> {
  const prefs = await loadAccounts(claudeOverride)
  const pinned = prefs.pinnedId ? prefs.accounts.find((a) => a.id === prefs.pinnedId) : undefined
  return pinned ?? prefs.accounts[0] ?? null
}

/**
 * Choose the account for a session that is about to spawn, and persist the
 * round-robin cursor so the next session gets a different one.
 */
export async function accountForSpawn(
  options: { sessionPath?: string; claudeOverride?: string },
  nowMs: number = Date.now(),
): Promise<ClaudeAccount | null> {
  const prefs = await loadAccounts(options.claudeOverride)
  const { account, cursor } = selectAccount(prefs, {
    nowMs,
    ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
  })
  if (cursor !== prefs.cursor) save({ ...prefs, cursor })
  // Cooldowns come from cached `/usage` readings, so a machine that has never
  // fetched one routes everything to account #1. Warm the cache in the
  // background — the next session start is the one that benefits.
  if (account && prefs.mode !== 'specific') {
    void refreshCooldowns(options.claudeOverride).catch(() => undefined)
  }
  return account
}

/** Remember which account a session ran on, so resuming it bills the same one. */
export async function bindSession(sessionPath: string, accountId: string): Promise<void> {
  const prefs = await loadAccounts()
  if (!prefs.accounts.some((a) => a.id === accountId)) return
  save({ ...prefs, bindings: { ...prefs.bindings, [sessionPath]: accountId } })
}

/**
 * Re-read every account's usage and turn "5-hour window at 100%" into a
 * cooldown. Fire-and-forget: one `claude -p /usage` per account, zero quota,
 * ~2s each, all in parallel, and a failure just leaves the old cooldown.
 */
export async function refreshCooldowns(claudeOverride?: string): Promise<void> {
  const prefs = await loadAccounts(claudeOverride)
  const now = Date.now()
  const results = await Promise.all(
    prefs.accounts.map(async (account) => {
      const result = await fetchUsageSnapshot({
        cacheKey: account.id,
        extraEnv: claudeAccountEnv(account),
        ...(claudeOverride ? { claudeOverride } : {}),
      }).catch(() => null)
      if (!result?.ok) return null
      return { id: account.id, until: cooldownFromUsage(result.snapshot.windows, now) }
    }),
  )
  const latest = getClaudeAccountPrefs()
  const cooldowns = { ...latest.cooldowns }
  for (const entry of results) {
    if (!entry) continue
    if (entry.until === null) delete cooldowns[entry.id]
    else cooldowns[entry.id] = entry.until
  }
  save({ ...latest, cooldowns })
}

/** Accounts plus their live auth state and whatever usage main already has. */
export async function accountViews(claudeOverride?: string): Promise<ClaudeAccountsResult> {
  const prefs = await loadAccounts(claudeOverride)
  const now = Date.now()
  const views: ClaudeAccountView[] = await Promise.all(
    prefs.accounts.map(async (account) => {
      const status = await claudeStatus(claudeOverride, claudeAccountEnv(account)).catch(() => null)
      const cooldown = prefs.cooldowns[account.id]
      return {
        account,
        auth: status?.auth ?? { ok: false, error: 'status check failed' },
        usage: cachedUsageSnapshot(account.id, now),
        cooldownUntil: cooldown !== undefined && cooldown > now ? cooldown : null,
      }
    }),
  )
  return { prefs, views }
}

/**
 * Create the record a sign-in will fill, and hand back the env it must run
 * under. Called before `claude auth login`, not after: the CLI writes its
 * credential the moment the browser flow lands, so the directory that decides
 * *where* has to exist first.
 */
export async function beginAddAccount(
  claudeOverride?: string,
): Promise<{ id: string; env: Record<string, string> }> {
  const prefs = await loadAccounts(claudeOverride)
  // The very first account takes the CLI's default entry, so an install with
  // no login at all does not start by inventing a directory.
  if (prefs.accounts.length === 0) return { id: 'default', env: {} }
  const id = randomUUID()
  const dir = join(accountsRoot(), id)
  mkdirSync(dir, { recursive: true })
  return { id, env: claudeAccountEnv({ credentialDir: dir } as ClaudeAccount) }
}

/**
 * Record the account a completed sign-in produced.
 *
 * Identity comes from `claude auth status` under the new credential, never
 * from the login output — the CLI prints "Login successful." for a rejected
 * code too (see `claude-login.ts`). A sign-in that did not actually land
 * leaves no account behind.
 */
export async function finishAddAccount(
  id: string,
  claudeOverride?: string,
): Promise<ClaudeAccount | null> {
  const prefs = await loadAccounts(claudeOverride)
  const existing = prefs.accounts.find((a) => a.id === id)
  const credentialDir = existing
    ? existing.credentialDir
    : id === 'default'
      ? null
      : join(accountsRoot(), id)
  const status = await claudeStatus(
    claudeOverride,
    claudeAccountEnv({ credentialDir } as ClaudeAccount),
  ).catch(() => null)
  if (status?.auth.loggedIn !== true) return null

  // "Add account" that lands on an email already in the list is a
  // re-authentication, not a second plan: two rows for one subscription would
  // make round-robin spread load across nothing and double-count its quota.
  // The row keeps its id and place and takes the NEW credential directory,
  // because that is where the CLI just wrote the working token.
  const duplicate =
    !existing && status.auth.email
      ? prefs.accounts.find((a) => a.email === status.auth.email)
      : undefined
  const target = existing ?? duplicate

  const account: ClaudeAccount = {
    id: target?.id ?? id,
    label: target?.label ?? status.auth.email ?? 'Claude account',
    ...(status.auth.email ? { email: status.auth.email } : {}),
    ...(status.auth.plan ? { plan: status.auth.plan } : {}),
    ...(status.auth.organization ? { organization: status.auth.organization } : {}),
    ...(status.auth.orgId ? { orgId: status.auth.orgId } : {}),
    credentialDir,
    addedAt: target?.addedAt ?? Date.now(),
  }
  const accounts = target
    ? prefs.accounts.map((a) => (a.id === target.id ? account : a))
    : [...prefs.accounts, account]
  save({ ...prefs, accounts, pinnedId: prefs.pinnedId ?? account.id })
  clearUsageCache(account.id)
  return account
}

/** Sign an account out and forget it. Its credential dir is left in place. */
export async function removeAccount(id: string, claudeOverride?: string): Promise<void> {
  const prefs = await loadAccounts(claudeOverride)
  const account = prefs.accounts.find((a) => a.id === id)
  if (!account) return
  // Best effort: a logout that fails must not strand the row in the UI.
  await logoutClaude(claudeOverride, claudeAccountEnv(account)).catch(() => undefined)
  const accounts = prefs.accounts.filter((a) => a.id !== id)
  save({
    ...prefs,
    accounts,
    ...(prefs.pinnedId === id ? { pinnedId: accounts[0]?.id } : {}),
  })
  clearUsageCache(id)
}

/** Reorder by id. Ids not in the list are appended, unknown ones ignored. */
export async function reorderAccounts(ids: string[], claudeOverride?: string): Promise<void> {
  const prefs = await loadAccounts(claudeOverride)
  const byId = new Map(prefs.accounts.map((a) => [a.id, a]))
  const ordered = ids.flatMap((id) => {
    const account = byId.get(id)
    if (!account) return []
    byId.delete(id)
    return [account]
  })
  save({ ...prefs, accounts: [...ordered, ...byId.values()] })
}

/** Set the routing rule, and for `specific` which account it points at. */
export async function setRouting(
  mode: ClaudeRoutingMode,
  pinnedId: string | undefined,
  claudeOverride?: string,
): Promise<void> {
  const prefs = await loadAccounts(claudeOverride)
  save({ ...prefs, mode, ...(pinnedId ? { pinnedId } : {}) })
}

/**
 * Hold an account back from new sessions until `untilMs`.
 *
 * Fed by the provider's own rate-limit reports (`electron/ipc/pi-session-handlers.ts`),
 * which arrive free, per turn, and know about a state `/usage` polling does
 * not surface as a window: an account past its plan allowance and spending
 * pay-as-you-go credits. Requests still succeed there, so without this the
 * router keeps handing out the one account that costs money.
 *
 * A no-op when it would shorten an existing hold — the reports repeat, and a
 * later one must not walk a cooldown backwards.
 */
export async function holdAccount(accountId: string, untilMs: number): Promise<void> {
  const prefs = getClaudeAccountPrefs()
  if (!prefs.accounts.some((a) => a.id === accountId)) return
  if ((prefs.cooldowns[accountId] ?? 0) >= untilMs) return
  save({ ...prefs, cooldowns: { ...prefs.cooldowns, [accountId]: untilMs } })
}

/**
 * Which account is billing this session, for the UI that has to say so.
 *
 * Two sources, in order: the live pick parked at spawn, then the persisted
 * binding under the session's own file path (a resumed session, or one whose
 * pi subprocess has since been released).
 */
export async function sessionAccount(options: {
  accountId?: string | undefined
  sessionPath?: string | undefined
  claudeOverride?: string | undefined
}): Promise<ClaudeSessionAccount | null> {
  const prefs = await loadAccounts(options.claudeOverride)
  const id =
    options.accountId ?? (options.sessionPath ? prefs.bindings[options.sessionPath] : undefined)
  if (!id) return null
  const account = prefs.accounts.find((a) => a.id === id)
  if (!account) return null
  const now = Date.now()
  const cooldown = prefs.cooldowns[account.id]
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    total: prefs.accounts.length,
    mode: prefs.mode,
    cooldownUntil: cooldown !== undefined && cooldown > now ? cooldown : null,
    /** Another account is available and not itself on hold. */
    alternative:
      prefs.accounts.find((a) => a.id !== account.id && !isCoolingDown(prefs, a.id, now))?.label ??
      null,
  }
}
