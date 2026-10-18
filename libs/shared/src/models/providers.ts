export const DEFAULT_CLAUDE_ACCOUNT_PREFS: ClaudeAccountPrefs = {
  accounts: [],
  mode: 'specific',
  cursor: 0,
  cooldowns: {},
  bindings: {},
}

/** Local `claude auth status` result (no network round-trip). */
export interface ClaudeAuthStatus {
  ok: boolean
  loggedIn?: boolean
  method?: string
  email?: string
  /** `subscriptionType`, e.g. `pro` / `max` / `team`. Which plan pays. */
  plan?: string
  /** `orgName` — present for team/enterprise logins, the giveaway for a wrong account. */
  organization?: string
  /** `orgId`. Pinned back onto a session as `CLAUDE_CODE_ORGANIZATION_UUID`. */
  orgId?: string
  error?: string
}

/** Claude Code CLI health for the provider tab. */
export interface ClaudeStatus {
  binary: { found: boolean; path?: string; version?: string }
  auth: ClaudeAuthStatus
}

/** Account-reported usage, shared by Claude's CLI panel and ChatGPT's API.
 * Percent consumed, not remaining; never estimated from session token counts. */
export interface PlanUsageWindow {
  /** Provider label, e.g. "Current session" or "Weekly". */
  label: string
  /** Derived from Claude's label or Codex's window duration. */
  kind: 'five_hour' | 'weekly' | 'weekly_model' | 'other'
  /** Percentage of the window consumed. */
  percentUsed: number
  /** When the window resets, Unix ms; null when the reset didn't parse. */
  resetsAt: number | null
}

export type ClaudeUsageWindow = PlanUsageWindow

/** Sanitized ChatGPT subscription usage. No credentials or upstream body cross IPC. */
export type CodexUsageResult =
  | {
      ok: true
      snapshot: {
        fetchedAt: number
        windows: PlanUsageWindow[]
        credits: { limit: number; remaining: number; resetsAt: number | null } | null
      }
    }
  | { ok: false; error: 'auth-unavailable' | 'request-failed' | 'rate-limited' | 'no-usage' }

/** Result of one `claude -p /usage` run. */
export interface ClaudeUsageSnapshot {
  fetchedAt: number
  /** True when the CLI served its cache ("Showing last-known usage"). */
  stale: boolean
  windows: ClaudeUsageWindow[]
  /** The "What's contributing to your limits usage?" block, verbatim, when present. */
  contributing: string | null
}

// ---------- Claude Code accounts ----------

/**
 * One Claude Code login Phosphor can route a session to.
 *
 * Multiple accounts are possible because the CLI derives its keychain service
 * name from a config directory: `CLAUDE_SECURESTORAGE_CONFIG_DIR` appends a
 * hash of that directory to `Claude Code-credentials`, giving each account its
 * own credential while `~/.claude` (projects, settings, skills, plugins) stays
 * shared. Verified against Claude Code 2.1.260.
 */
export interface ClaudeAccount {
  /** Stable id; also the folder name under the accounts directory. */
  id: string
  /** What the UI shows. Defaults to the email the CLI reported at sign-in. */
  label: string
  email?: string
  /** `subscriptionType` at sign-in, e.g. `pro` / `max` / `team`. */
  plan?: string
  organization?: string
  /**
   * `orgId` at sign-in, passed back as `CLAUDE_CODE_ORGANIZATION_UUID`.
   *
   * `~/.claude.json`'s `oauthAccount` block is keyed by `CLAUDE_CONFIG_DIR`,
   * NOT by the securestorage dir, so all accounts share it and the last one to
   * sign in wins its org id. The CLI reads this env var ahead of that block,
   * which is what keeps a session's org matched to its token.
   */
  orgId?: string
  /**
   * Credential directory, or null for the CLI's own default keychain entry —
   * the one your terminal `claude` uses. The first account is seeded as null
   * so nothing has to migrate.
   */
  credentialDir: string | null
  addedAt: number
}

/** How a new session picks which account bills it. */
export type ClaudeRoutingMode = 'specific' | 'ordered' | 'round-robin'

/** Accounts, their order, and the routing rule over them. */
export interface ClaudeAccountPrefs {
  /** Ordered — `ordered` mode walks this top to bottom. */
  accounts: ClaudeAccount[]
  mode: ClaudeRoutingMode
  /** Which account `specific` mode uses. Falls back to the first. */
  pinnedId?: string
  /** Next index `round-robin` hands out. */
  cursor: number
  /**
   * Account id → epoch ms its 5-hour window resets, for accounts observed at
   * 100%. `ordered` and `round-robin` skip an account until then.
   */
  cooldowns: Record<string, number>
  /** Session file path → account id, so a resumed session keeps its billing. */
  bindings: Record<string, string>
}

/** An account plus the live facts the settings tab needs to render it. */
export interface ClaudeAccountView {
  account: ClaudeAccount
  auth: ClaudeAuthStatus
  /** Cached usage, when main has a fresh enough snapshot. Never fetched inline. */
  usage: ClaudeUsageSnapshot | null
  /** Cooldown expiry from `ClaudeAccountPrefs.cooldowns`, when active. */
  cooldownUntil: number | null
}

/**
 * Which Claude login a live session bills, for the surfaces that must say so.
 *
 * A lane's account is decided once, at spawn, and nothing downstream carried
 * it: the context popover asked the CLI for "the" plan usage with no account
 * env at all, so on a multi-account install it could show a different account's
 * windows than the lane was actually spending. `claude:sessionAccount` is the
 * answer to "whose quota is this lane eating".
 */
export interface ClaudeSessionAccount {
  id: string
  label: string
  email?: string
  plan?: string
  /** How many accounts are configured, so the UI can stay quiet when it is 1. */
  total: number
  mode: ClaudeRoutingMode
  /** When this account is held back from new sessions, if it is. */
  cooldownUntil: number | null
  /**
   * An account new sessions would go to instead, when this one is held.
   *
   * Carries the id as well as the label because the surfaces that name it now
   * also offer to move the lane there, and a move needs an id.
   */
  alternative: { id: string; label: string } | null
}

/**
 * Which live lanes are spending which Claude account: account id → Phosphor
 * session ids, as parked at spawn (`apps/desktop/electron/pi/session-accounts.ts`).
 *
 * Only ids cross the wire. Titles, folders and session files are the
 * renderer's to resolve — it already holds all three — and an account with no
 * live lane is simply absent from the map.
 */
export type ClaudeAccountSessions = Record<string, string[]>

/** `claude:accounts` channel result. */
export interface ClaudeAccountsResult {
  prefs: ClaudeAccountPrefs
  views: ClaudeAccountView[]
}

/** Why a `claude -p /usage` run produced no windows. */
export type ClaudeUsageError = 'claude-not-found' | 'run-failed' | 'no-usage'

/** `claude:usageSnapshot` channel result. */
export type ClaudeUsageSnapshotResult =
  { ok: true; snapshot: ClaudeUsageSnapshot } | { ok: false; error: ClaudeUsageError }
