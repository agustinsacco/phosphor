import type { SessionStats, Usage } from '@shared/rpc'

/**
 * Live session stats from the event stream, replacing most of the
 * `get_session_stats` polling.
 *
 * The context meter used to climb live by polling on every completed
 * sub-step — MEASURED at ~26 round trips per user turn across 12 real
 * sessions (2 for a short chat, 91 for a tool-heavy run). Since pi 0.84.2,
 * `message_update` carries the streaming message's cumulative `usage` for
 * free, so the meter can climb from data already arriving and the poll can
 * retreat to turn boundaries.
 *
 * The accounting must match pi's, which was read from its source (0.84.4),
 * not guessed:
 *
 * - `message_update.usage` is the CURRENT MESSAGE's usage, cumulative as of
 *   the delta — not session-cumulative. pi emits one assistant message per
 *   tool hop, so summing deltas naively would multiply-count a turn.
 * - Session totals are therefore `base + current`: `base` is re-seeded from
 *   every authoritative `get_session_stats` answer and advanced by each
 *   `message_end`'s final usage; `current` is the streaming message.
 * - pi's own context estimate (`estimateContextTokens`) is the LAST assistant
 *   usage's `totalTokens || input+output+cacheRead+cacheWrite`, plus a
 *   trailing estimate that is zero while that message is the latest — which
 *   during streaming it always is. So the live meter uses exactly that
 *   formula against the context window the last poll reported.
 *
 * Capability is detected, not version-checked: pi < 0.84.2 sends no `usage`
 * on deltas, `hasUsageDeltas` stays false, and the caller keeps the old
 * per-sub-step polling. Phosphor does not control which pi is installed.
 */

interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface LiveStatsEntry {
  /** Session totals as of the last authoritative poll plus ended messages. */
  base: TokenTotals & { cost: number }
  /** The message currently streaming, per its latest delta. */
  current: Usage | null
  /** The last polled stats, which the live patch overlays. */
  polled: SessionStats | null
  seenUsageDelta: boolean
}

const entries = new Map<string, LiveStatsEntry>()

function entryFor(sessionId: string): LiveStatsEntry {
  let entry = entries.get(sessionId)
  if (!entry) {
    entry = {
      base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      current: null,
      polled: null,
      seenUsageDelta: false,
    }
    entries.set(sessionId, entry)
  }
  return entry
}

/** pi's `calculateContextTokens`, verbatim: totalTokens wins when present. */
export function contextTokensOf(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/** True once this session has shown `usage` on a delta (pi ≥ 0.84.2). */
export function hasUsageDeltas(sessionId: string): boolean {
  return entries.get(sessionId)?.seenUsageDelta ?? false
}

/** An authoritative `get_session_stats` answer landed: re-seed everything. */
export function recordPolledStats(sessionId: string, stats: SessionStats): void {
  const entry = entryFor(sessionId)
  entry.polled = stats
  entry.base = { ...stats.tokens, cost: stats.cost }
  // The poll already includes anything that was streaming when pi answered;
  // keeping `current` would double-count it in the next overlay.
  entry.current = null
}

/**
 * A `message_update` carried usage. Returns the patched stats to display, or
 * null before the first poll has seeded a baseline (the meter has nothing to
 * overlay yet — bootstrap polls within the first second of a session).
 */
export function recordUsageDelta(sessionId: string, usage: Usage): SessionStats | null {
  const entry = entryFor(sessionId)
  entry.seenUsageDelta = true
  entry.current = usage
  return overlay(entry)
}

/**
 * An assistant message finished. Its final usage moves from `current` into
 * `base`, so the next message's deltas stack on top instead of replacing it.
 */
export function recordMessageEnd(sessionId: string, usage: Usage | undefined): SessionStats | null {
  const entry = entries.get(sessionId)
  if (!entry || !entry.seenUsageDelta) return null
  if (usage) {
    entry.base.input += usage.input
    entry.base.output += usage.output
    entry.base.cacheRead += usage.cacheRead
    entry.base.cacheWrite += usage.cacheWrite
    entry.base.cost += usage.cost?.total ?? 0
  }
  entry.current = null
  return overlay(entry)
}

export function clearLiveStats(sessionId: string): void {
  entries.delete(sessionId)
}

/** The polled stats with live totals and pi's own context estimate on top. */
function overlay(entry: LiveStatsEntry): SessionStats | null {
  const polled = entry.polled
  if (!polled) return null

  const current = entry.current
  const tokens = {
    input: entry.base.input + (current?.input ?? 0),
    output: entry.base.output + (current?.output ?? 0),
    cacheRead: entry.base.cacheRead + (current?.cacheRead ?? 0),
    cacheWrite: entry.base.cacheWrite + (current?.cacheWrite ?? 0),
    total: 0,
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

  // Context: only while a message is streaming does the estimate move, and
  // only when the window is known (it comes from the poll). After compaction
  // pi reports null tokens until fresh usage arrives — a streaming message IS
  // fresh usage, so overlaying is correct there too.
  let contextUsage = polled.contextUsage
  if (current && contextUsage && contextUsage.contextWindow > 0) {
    const contextTokens = contextTokensOf(current)
    if (contextTokens > 0) {
      contextUsage = {
        tokens: contextTokens,
        contextWindow: contextUsage.contextWindow,
        percent: (contextTokens / contextUsage.contextWindow) * 100,
      }
    }
  }

  return {
    ...polled,
    tokens,
    cost: entry.base.cost + (current?.cost?.total ?? 0),
    contextUsage,
  }
}

/** Session-cumulative billed tokens right now, for burn-rate samples. */
export function liveBilledTokens(sessionId: string): number | null {
  const entry = entries.get(sessionId)
  if (!entry || !entry.polled) return null
  const current = entry.current
  return (
    entry.base.input +
    entry.base.output +
    entry.base.cacheRead +
    entry.base.cacheWrite +
    (current ? current.input + current.output + current.cacheRead + current.cacheWrite : 0)
  )
}
