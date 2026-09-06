/**
 * Which Claude account bills a session.
 *
 * Pure on purpose: the interesting part is the rule, and the rule is the part
 * that has to be right at 2am when one account is exhausted. Everything that
 * spawns, reads the keychain or writes prefs lives in `accounts.ts`.
 *
 * Selection happens ONCE, when a session spawns. It cannot happen later: the
 * CLI process is parked for the life of the session (pi-claude-cli >= 0.7.0),
 * and its credential is fixed by the environment it was spawned with. So
 * "ordered" means *start* on the first account that is not exhausted, not fail
 * over mid-turn — a session that hits its limit is a session the user restarts.
 */
import type { ClaudeAccount, ClaudeAccountPrefs, ClaudeAuthStatus } from '@shared/models'

/**
 * Environment that points the CLI at one account's credential.
 *
 * Empty for the default account: an *unset* variable is what selects the
 * keychain entry the terminal already uses, and setting it to `~/.claude`
 * would not be equivalent (`e !== undefined` flips the hash suffix on).
 */
export function claudeAccountEnv(account: ClaudeAccount | null): Record<string, string> {
  if (!account?.credentialDir) return {}
  return {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: account.credentialDir,
    // Pinned because `~/.claude.json`'s `oauthAccount` is shared by every
    // account (it follows CLAUDE_CONFIG_DIR, not the securestorage dir), so
    // the last sign-in wins its org id. The CLI reads this variable first.
    ...(account.orgId ? { CLAUDE_CODE_ORGANIZATION_UUID: account.orgId } : {}),
  }
}

/**
 * Live `claude auth status` identity, kept only when it belongs to this account.
 *
 * The CLI reads the *token* from this account's own keychain entry, but prints
 * `email` / `subscriptionType` / `orgName` from `~/.claude.json`'s
 * `oauthAccount` block — which follows `CLAUDE_CONFIG_DIR`, not the
 * securestorage dir, so every account shares it and whichever signed in last
 * wins. Left alone, every row in the accounts list describes that one account.
 *
 * So the reported identity is trusted only when its email matches the one
 * recorded at sign-in; otherwise the identity fields are dropped and the caller
 * falls back to the stored record. `loggedIn` is per-account (it comes from the
 * keychain entry) and is always kept.
 */
export function reconcileAuthIdentity(
  account: ClaudeAccount,
  auth: ClaudeAuthStatus,
): ClaudeAuthStatus {
  const same =
    !account.email || !auth.email || account.email.toLowerCase() === auth.email.toLowerCase()
  if (same) return auth
  const { email: _email, plan: _plan, organization: _org, orgId: _orgId, ...rest } = auth
  return rest
}

export interface Selection {
  /** null = no account configured; the spawn gets no credential env at all. */
  account: ClaudeAccount | null
  /** Cursor to persist. Only moves for `round-robin`. */
  cursor: number
}

/** Is this account known to be out of 5-hour quota right now? */
export function isCoolingDown(
  prefs: Pick<ClaudeAccountPrefs, 'cooldowns'>,
  accountId: string,
  nowMs: number,
): boolean {
  const until = prefs.cooldowns[accountId]
  return until !== undefined && until > nowMs
}

/**
 * Pick the account for a new session.
 *
 * A pinned/bound account wins outright — `bindings` is how a resumed session
 * keeps its billing, and switching accounts mid-thread would miss the whole
 * prompt cache as well as split the transcript's cost across two plans.
 *
 * When every account is cooling down the rule still returns one rather than
 * refusing to start a session: the cooldowns are derived from a cached
 * `/usage` reading, so "all exhausted" is as likely to mean "stale data" as it
 * is to mean "genuinely out", and refusing to spawn on stale data is worse
 * than spawning onto a limit the CLI will report properly.
 */
export function selectAccount(
  prefs: ClaudeAccountPrefs,
  options: { sessionPath?: string; nowMs: number },
): Selection {
  const { accounts, cursor } = prefs
  if (accounts.length === 0) return { account: null, cursor }

  const bound = options.sessionPath ? prefs.bindings[options.sessionPath] : undefined
  const boundAccount = bound ? accounts.find((a) => a.id === bound) : undefined
  if (boundAccount) return { account: boundAccount, cursor }

  if (prefs.mode === 'specific') {
    const pinned = prefs.pinnedId ? accounts.find((a) => a.id === prefs.pinnedId) : undefined
    return { account: pinned ?? accounts[0]!, cursor }
  }

  if (prefs.mode === 'ordered') {
    const free = accounts.find((a) => !isCoolingDown(prefs, a.id, options.nowMs))
    return { account: free ?? accounts[0]!, cursor }
  }

  // round-robin: hand out the next account, skipping ones on cooldown. The
  // cursor advances past whatever was handed out, so the skip does not make
  // the same busy account the next candidate forever.
  const start = ((cursor % accounts.length) + accounts.length) % accounts.length
  for (let step = 0; step < accounts.length; step++) {
    const index = (start + step) % accounts.length
    const candidate = accounts[index]!
    if (isCoolingDown(prefs, candidate.id, options.nowMs)) continue
    return { account: candidate, cursor: (index + 1) % accounts.length }
  }
  return { account: accounts[start]!, cursor: (start + 1) % accounts.length }
}

/**
 * When does this account's 5-hour window free up, given a usage reading?
 *
 * Only the 5-hour window counts. A weekly window at 100% is a real block too,
 * but its reset is days away and skipping an account for days on the strength
 * of one cached reading is not a trade pidex should make silently.
 *
 * Returns null when the account is not exhausted, which the caller stores as
 * "clear any cooldown" rather than "leave the old one".
 */
export function cooldownFromUsage(
  windows: { kind: string; percentUsed: number; resetsAt: number | null }[],
  nowMs: number,
): number | null {
  const fiveHour = windows.find((w) => w.kind === 'five_hour')
  if (!fiveHour || fiveHour.percentUsed < 100) return null
  // No parsed reset stamp still means exhausted; hold it for one window.
  const resetsAt = fiveHour.resetsAt ?? nowMs + 5 * 60 * 60 * 1000
  return resetsAt > nowMs ? resetsAt : null
}

/** Drop cooldowns that have expired, so the stored map cannot grow forever. */
export function pruneCooldowns(
  cooldowns: Record<string, number>,
  knownIds: Set<string>,
  nowMs: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(cooldowns).filter(([id, until]) => knownIds.has(id) && until > nowMs),
  )
}
