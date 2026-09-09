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
 *
 * NOT EVERY PROVIDER REPORTS USAGE WHILE IT STREAMS, and one that doesn't
 * broke the meter outright. The OpenAI Responses API — so `openai-codex`,
 * i.e. GPT-5.x/GPT-6 on a ChatGPT subscription — fills usage ONLY on its
 * terminal `response.completed` event (measured 2026-09-09: 9 SSE events, the
 * 9th the only one carrying a `usage` object; pi's `finalizeResponse` is the
 * sole writer of `output.usage`). Every `message_update` therefore ships a
 * present-but-zeroed usage object, which is the worst of both worlds:
 *
 * - `hasUsageDeltas` flips true, because the FIELD is there — so the caller
 *   narrows polling to `agent_end`/`compaction_end`;
 * - but `contextTokensOf(current)` is 0, so the streaming overlay below
 *   refuses it and the context figure never moves.
 *
 * Nothing then advanced the estimate until the whole turn ended. A real codex
 * session spent one turn on 95 tool calls and 5.7M cache-read tokens while the
 * meter showed the bootstrap poll's 543 tokens — 0% against a 272k window,
 * under-reporting the true 128,736 by 237×. And because `contextBreakdown`
 * clamps its component estimates DOWN to fit pi's total, that stale total
 * crushed every slice with it (a 41-token system prompt, 43 tokens for 31 tool
 * schemas), so the whole composition panel read as nonsense.
 *
 * The fix is to take the estimate from `message_end` too, which carries the
 * message's final, authoritative usage on every provider. pi emits one
 * assistant message per tool hop, so for codex that is a fresh true reading
 * per hop (61 of them in the session above) at no round-trip cost. See
 * `overlay`'s context section for the precedence rule.
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
  /**
   * Final usage of the last assistant message to END SINCE THE LAST POLL, kept
   * only to feed the context estimate. Cleared by every poll, so it is either
   * null or strictly newer than `polled.contextUsage` — which is what makes it
   * safe to prefer over it, including after a compaction (pi reports null
   * tokens there, and the poll that follows `compaction_end` clears this).
   */
  lastEnded: Usage | null
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
      lastEnded: null,
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
  // keeping `current` would double-count it in the next overlay. `lastEnded`
  // goes for the same reason AND for a sharper one: pi's answer is the ground
  // truth for context, so a reading banked before it must not outrank it.
  entry.current = null
  entry.lastEnded = null
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
 * `base`, so the next message's deltas stack on top instead of replacing it —
 * and is banked as `lastEnded` for the context estimate, which is the only
 * true reading a completion-only provider ever gives us mid-turn.
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
    // An aborted or errored message can end with nothing spent, and pi skips
    // exactly those when it computes its own estimate (`getAssistantUsage`).
    if (contextTokensOf(usage) > 0) entry.lastEnded = usage
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

  // Context: the newest true reading wins, and only when the window is known
  // (it comes from the poll). After compaction pi reports null tokens until
  // fresh usage arrives — both sources below ARE fresh usage, since a poll
  // clears them, so overlaying is correct there too.
  //
  // Precedence is newest-first: the streaming message when it has told us
  // anything, else the last message to have ended since the poll. The second
  // arm is what carries a provider that reports usage only at completion; for
  // one that streams usage, `current` always wins and this is inert.
  let contextUsage = polled.contextUsage
  const source = current && contextTokensOf(current) > 0 ? current : entry.lastEnded
  if (source && contextUsage && contextUsage.contextWindow > 0) {
    const contextTokens = contextTokensOf(source)
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
