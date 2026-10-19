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
 * The parser is shared with the Host (`@shared/claude-usage`); a remote lane
 * reads the Host's own answer over `machine.claudeUsage`.
 */
import { tmpdir } from 'node:os'
import { runPrintMode } from '../pi/print-mode'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '../pi/shell-env'
import { parseUsageOutput } from '@shared/claude-usage'
import type { ClaudeUsageSnapshot, ClaudeUsageSnapshotResult } from '@shared/models'

export { parseResetStamp, parseUsageOutput, parseUsageText, windowKind } from '@shared/claude-usage'

/**
 * How long a fetched snapshot is reused. The upstream endpoint rate-limits
 * (the CLI itself falls back to "last-known usage" when it trips), so Phosphor
 * must not ask more often than roughly a minute even across many surfaces.
 */
const CACHE_TTL_MS = 60_000

// ---------------------------------------------------------------------------
// Fetching — spawns the CLI; the shared parser stays pure for tests.
// ---------------------------------------------------------------------------

/** Runner seam for tests: returns one run's stdout, or null when it failed. */
export type UsageRunner = (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<string | null>

async function defaultRunner(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  // `--no-session-persistence`: without it every poll saved a transcript under
  // ~/.claude/projects/<tmpdir> — nearly a thousand of them on one install.
  const result = await runPrintMode(
    binaryPath,
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    { cwd: tmpdir(), env, timeoutMs: 20_000 },
  )
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
