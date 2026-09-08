/**
 * Live subscription usage, read from `claude -p /usage --output-format json`.
 *
 * The CLI's own `/usage` panel is fed by Anthropic's internal
 * `GET /api/oauth/usage` endpoint — the same numbers Claude Desktop shows,
 * live, at any percentage (unlike `rate_limit_event`, whose `utilization`
 * only arrives after the CLI's warning threshold). Phosphor cannot call that
 * endpoint (the OAuth token is the CLI's, in the OS keychain, and the wire
 * is undocumented) — but the CLI prints the panel in print mode, so we spawn
 * it and parse its rendered answer. Zero model calls, zero quota
 * (`num_turns: 0`, `total_cost_usd: 0`), ~1.5–2 s per run, and no credential
 * ever crosses into Phosphor.
 *
 * The rendered text is a wire contract in the same sense as the
 * `[Claude Code · …]` markers: parsed narrowly, and any line Phosphor doesn't
 * recognise is ignored rather than guessed at. If the shape drifts so far
 * that nothing parses, the caller gets `no-usage` and hides the section —
 * never a wrong number. See docs/log/2026-08-30-usage-report-api-review.md.
 */
import { tmpdir } from 'node:os'
import { runPrintMode } from '../pi/print-mode'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '../pi/shell-env'
import type {
  ClaudeUsageSnapshot,
  ClaudeUsageSnapshotResult,
  ClaudeUsageWindow,
} from '@shared/models'

/**
 * How long a fetched snapshot is reused. The upstream endpoint rate-limits
 * (the CLI itself falls back to "last-known usage" when it trips), so Phosphor
 * must not ask more often than roughly a minute even across many surfaces.
 */
const CACHE_TTL_MS = 60_000

/** Month names as the CLI prints them (en-US, "Aug 30 at 2:49pm"). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A usage line: `<label>: <n>% used` with an optional
 * `· resets <MMM D at h:mm(am|pm)> (<tz>)`. Narrow on purpose — the labels
 * themselves are an open set ("Current week (Fable)", "One-time credit ·
 * Expires …"), so the label passes through and only the shape is enforced.
 */
const WINDOW_LINE = /^(.+?): (\d+)% used(?: · resets ([^·]+?))?(?: \([^)]+\))?$/

/** The CLI's honesty flags, surfaced in the snapshot instead of papered over. */
const LAST_KNOWN_MARKER = /Showing last-known usage/
const REFRESH_FAILED_MARKER = /Could not refresh usage data/

/** Where the behavioral context begins, if the CLI included it (both apostrophes seen in the wild). */
const CONTRIBUTING_HEADING = /^What['\u2019]s contributing to your limits usage\?$/

/**
 * Parse the CLI's reset stamp in the machine's local timezone.
 *
 * "Aug 30 at 2:49pm" — no year, because the CLI renders a human stamp. The
 * year is inferred as the first candidate (this year, then next) that lands
 * in the future, which handles the December→January rollover; a valid shape
 * therefore almost always yields a future instant. The renderer still
 * guards with its own "past reset ⇒ no countdown" rule
 * (`resetLabel` in `composer/rateLimit.ts`).
 */
export function parseResetStamp(text: string, nowMs: number = Date.now()): number | null {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(text.trim())
  if (!match) return null
  const monthName = match[1]
  const dayText = match[2]
  const hourText = match[3]
  const minuteText = match[4]
  const meridiem = match[5]
  if (monthName === undefined || dayText === undefined || hourText === undefined) return null
  const month = MONTHS.indexOf(monthName)
  const day = Number(dayText)
  if (month === -1 || day < 1 || day > 31) return null
  let hour = Number(hourText) % 12
  if (meridiem === 'pm') hour += 12
  const minute = minuteText ? Number(minuteText) : 0

  const now = new Date(nowMs)
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const at = new Date(year, month, day, hour, minute, 0, 0).getTime()
    if (Number.isFinite(at) && at > nowMs) return at
  }
  return null
}

/** Window family from the CLI's rendered label. */
export function windowKind(label: string): ClaudeUsageWindow['kind'] {
  if (label === 'Current session') return 'five_hour'
  if (label === 'Current week (all models)') return 'weekly'
  if (/^Current week \((.+)\)$/.test(label)) return 'weekly_model'
  return 'other'
}

/**
 * Parse the `result` text of one `/usage` run into a snapshot.
 *
 * Returns null when no usage line parses at all — signed out, API-key auth,
 * or a format drift; all three must render as "no data", not as zeros.
 */
export function parseUsageText(
  text: string,
  nowMs: number = Date.now(),
): ClaudeUsageSnapshot | null {
  const lines = text.split('\n')
  const windows: ClaudeUsageWindow[] = []
  let stale = false
  let contributing: string | null = null

  const headingIndex = lines.findIndex((line) => CONTRIBUTING_HEADING.test(line.trim()))
  const windowLines = headingIndex === -1 ? lines : lines.slice(0, headingIndex)
  if (headingIndex !== -1) {
    const block = lines
      .slice(headingIndex + 1)
      .join('\n')
      .trim()
    if (block) contributing = block
  }

  for (const line of windowLines) {
    if (LAST_KNOWN_MARKER.test(line)) {
      stale = true
      continue
    }
    if (REFRESH_FAILED_MARKER.test(line)) continue
    const match = WINDOW_LINE.exec(line.trim())
    if (!match) continue
    const label = match[1]?.trim()
    const percentText = match[2]
    const resetText = match[3]
    // Both capture groups are load-bearing; a match missing either is drift.
    if (!label || percentText === undefined) continue
    const percentUsed = Number(percentText)
    if (!Number.isFinite(percentUsed) || percentUsed < 0 || percentUsed > 200) continue
    windows.push({
      label,
      kind: windowKind(label),
      percentUsed,
      resetsAt: resetText ? parseResetStamp(resetText, nowMs) : null,
    })
  }

  if (windows.length === 0) return null
  return { fetchedAt: nowMs, stale, windows, contributing }
}

/** Parses the full `--output-format json` envelope of one run. */
export function parseUsageOutput(
  stdout: string,
  nowMs: number = Date.now(),
): ClaudeUsageSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: string }
    return typeof parsed.result === 'string' ? parseUsageText(parsed.result, nowMs) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fetching — spawns the CLI; the parser above stays pure for tests.
// ---------------------------------------------------------------------------

/** Runner seam for tests: returns one run's stdout, or null when it failed. */
export type UsageRunner = (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<string | null>

async function defaultRunner(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runPrintMode(binaryPath, ['-p', '/usage', '--output-format', 'json'], {
    cwd: tmpdir(),
    env,
    timeoutMs: 20_000,
  })
  // runPrintMode never rejects; an error means "no answer" here.
  return result.error ? null : result.stdout
}

interface CacheEntry {
  fetchedAt: number
  snapshot: ClaudeUsageSnapshot
}

/**
 * Keyed by account id, because every Claude account has its own quota and one
 * shared slot would show whichever one asked last. The default key covers
 * callers with no account context (the usage popover on a stock install).
 */
const DEFAULT_KEY = 'default'
const cached = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ClaudeUsageSnapshotResult>>()

/**
 * Whatever main already knows about an account, without spawning anything.
 *
 * The routing code reads usage this way on the session-start path: a
 * `claude -p /usage` run is ~2s, and paying that per account before a session
 * can start is not a trade worth making for a cooldown that is refreshed in
 * the background anyway.
 */
export function cachedUsageSnapshot(
  cacheKey: string,
  nowMs: number = Date.now(),
): ClaudeUsageSnapshot | null {
  const entry = cached.get(cacheKey)
  if (!entry || nowMs - entry.fetchedAt >= CACHE_TTL_MS) return null
  return entry.snapshot
}

/**
 * Current usage snapshot, spawning `claude -p /usage` when the cache is older
 * than the TTL. Concurrent callers share one run (the endpoint rate-limits,
 * so a second identical request must not spawn a second CLI). Failure
 * results are never cached — the next ask retries.
 */
export async function fetchUsageSnapshot(options?: {
  claudeOverride?: string
  nowMs?: number
  runner?: UsageRunner
  /** Account id. Omitted means the CLI's default credential. */
  cacheKey?: string
  /** Credential-scoping env for one account; see electron/claude/accounts.ts. */
  extraEnv?: Record<string, string>
  /**
   * Ignore a fresh cache entry and re-run. For a user-initiated refresh only:
   * a refresh button that returns the cached answer looks broken. The
   * in-flight share below still applies, so a double click is one run.
   */
  force?: boolean
}): Promise<ClaudeUsageSnapshotResult> {
  const nowMs = options?.nowMs ?? Date.now()
  const key = options?.cacheKey ?? DEFAULT_KEY
  const hit = cached.get(key)
  if (!options?.force && hit && nowMs - hit.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, snapshot: hit.snapshot }
  }
  const pending = inFlight.get(key)
  if (pending) return pending

  const run = (async (): Promise<ClaudeUsageSnapshotResult> => {
    const binaryPath = options?.claudeOverride ?? (await resolveBinary('claude'))
    if (!binaryPath) return { ok: false, error: 'claude-not-found' }
    const env = { ...(await piProcessEnv()), ...options?.extraEnv }
    const stdout = await (options?.runner ?? defaultRunner)(binaryPath, env)
    if (stdout === null) return { ok: false, error: 'run-failed' }
    const snapshot = parseUsageOutput(stdout, nowMs)
    if (!snapshot) return { ok: false, error: 'no-usage' }
    cached.set(key, { fetchedAt: snapshot.fetchedAt, snapshot })
    return { ok: true, snapshot }
  })()
  inFlight.set(key, run)

  try {
    return await run
  } finally {
    inFlight.delete(key)
  }
}

/** Test seam, and the reset after a sign-in: drop one key, or all of them. */
export function clearUsageCache(cacheKey?: string): void {
  if (cacheKey === undefined) cached.clear()
  else cached.delete(cacheKey)
}
