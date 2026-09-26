/**
 * The context budget (Settings → Agent → Context budget,
 * `AppPrefs.contextBudget`). Claude receives PI_CLAUDE_CLI_AUTOCOMPACT;
 * Phosphor checks pi-owned sessions at settlement.
 *
 * Mirrors how pi-claude-cli parses the value (`resolveAutocompact` in its
 * `src/autocompact.ts`): `auto`, `off`, or a token count from 100k to 1M —
 * `k`/`M` suffixes accepted, bare numbers are thousands (the CLI's own
 * shorthand: `400` means 400k). Unset means the provider's own default.
 */

/** The window the provider passes when the setting is unset. */
export const DEFAULT_AUTOCOMPACT_TOKENS = 200_000

const MIN_TOKENS = 100_000
const MAX_TOKENS = 1_000_000

/** A well-formed window as a token count, or undefined when it is not one. */
function parseTokens(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const suffix = (m[2] ?? '').toLowerCase()
  if (suffix === 'k') return Math.round(n * 1_000)
  if (suffix === 'm') return Math.round(n * 1_000_000)
  return n < MIN_TOKENS ? Math.round(n * 1_000) : Math.round(n)
}

/**
 * Format alone is not enough: `77k` is well-formed but below the CLI's
 * floor, and the provider would silently fall back to its default — a
 * number the user typed must never mean something else than what they
 * typed, so the range is enforced here too.
 */
export function isValidAutocompactValue(raw: string): boolean {
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'auto' || lowered === 'off') return true
  const tokens = parseTokens(raw)
  return tokens !== undefined && tokens >= MIN_TOKENS && tokens <= MAX_TOKENS
}

/**
 * The context budget a Claude Code session actually runs under: the token
 * count the provider will pass as `--autocompact`, or null when there is no
 * fixed budget (`auto` lets the CLI decide, `off` omits the flag).
 *
 * Unset and invalid both resolve to the provider's default, because that is
 * what the provider does with them. This is what the context meter divides by
 * on Claude sessions — the CLI's compaction is the only thing that shrinks
 * that context, so "how full is the budget" is the honest question, and the
 * model window is the wrong denominator when the budget is 500k.
 */
export function autocompactTokens(raw: string): number | null {
  const lowered = raw.trim().toLowerCase()
  if (lowered === '') return DEFAULT_AUTOCOMPACT_TOKENS
  if (lowered === 'auto' || lowered === 'off') return null
  const tokens = parseTokens(raw)
  if (tokens === undefined || tokens < MIN_TOKENS || tokens > MAX_TOKENS) {
    return DEFAULT_AUTOCOMPACT_TOKENS
  }
  return tokens
}

// Shared names for consumers outside the Claude settings tab.
export {
  DEFAULT_AUTOCOMPACT_TOKENS as DEFAULT_CONTEXT_BUDGET_TOKENS,
  autocompactTokens as contextBudgetTokens,
  isValidAutocompactValue as isValidContextBudgetValue,
}

/**
 * The configured budget, or null when this session uses only its native limit.
 * Claude owns compaction regardless of pi's toggle. Other providers opt out
 * when pi auto-compaction is disabled, or their window is no larger than the
 * budget. Native reserveTokens can still cause pi to compact sooner.
 */
export function sessionContextBudget(session: {
  raw: string
  provider: string | null | undefined
  contextWindow: number | null | undefined
  autoCompactionEnabled: boolean
}): number | null {
  const budget = autocompactTokens(session.raw)
  if (session.provider === 'pi-claude-cli') return budget
  if (budget === null || !session.autoCompactionEnabled) return null
  return (session.contextWindow ?? 0) > budget ? budget : null
}
