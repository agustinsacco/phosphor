/** Number and duration formatters shared across surfaces. */

/**
 * Compact token count: `1.5M`, `12k`, `999`.
 *
 * Sub-1k values are exact. The `k` tier keeps one decimal until 100k, past
 * which the extra digit is noise in a dense UI.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/**
 * Dollar cost: `$12.40`, `$0.53`, `$0.0042`, `$0`.
 *
 * Two decimals once the amount is real money (≥ $0.10); below that, four
 * significant-ish decimals with trailing zeros trimmed so tiny per-session
 * costs stay honest without reading as `$0.00`.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0'
  if (cost >= 0.1) return `$${cost.toFixed(2)}`
  const s = cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return `$${s}`
}

/** Elapsed time for tool runs: `840ms`, `1.4s`, `2m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * Size label for streamed payloads: `812 B`, `12.4 KB`, `1.2 MB`.
 *
 * Callers feed it `string.length` — UTF-16 code units, a LOWER BOUND on the
 * UTF-8 byte size (exact for ASCII payloads like JSON args; up to ~3x under
 * for CJK/emoji-heavy content). Deliberate: re-encoding a multi-MB payload
 * with TextEncoder on every streaming delta just to label a hint is waste.
 * Treat the value as progress, not as an exact transfer size.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
