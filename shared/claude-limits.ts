/**
 * The routing half of the Claude provider's rate-limit report.
 *
 * `@saccolabs/pi-claude-cli` pushes one JSON payload per changed rate-limit
 * event under this key (see docs/extensions.md — it is a wire contract, and it
 * crosses a repo boundary, so nothing here may throw on a shape it does not
 * recognise). The renderer parses the same payload for display in
 * `composer/rateLimit.ts`; this module answers the one question the MAIN
 * process needs, and is deliberately separate because the two consumers fail
 * differently: a display parser that returns null renders nothing, while this
 * one decides whether a paid account keeps taking new sessions.
 */

export const RATE_LIMIT_STATUS_KEY = 'claude-rate-limit'

/** One 5-hour window, used when the payload reports no reset of its own. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/**
 * When should routing stop handing this account to new sessions?
 *
 * Three states count as exhausted, and the third is the point of this file:
 *
 * 1. `status: "rejected"` — the API is refusing the account outright.
 * 2. the reported window is at or past 100%.
 * 3. **`isUsingOverage`** — the plan allowance is gone and the account is
 *    spending pay-as-you-go credits at API rates. Requests still succeed, so
 *    nothing else in the system notices; left alone, round-robin keeps handing
 *    out the account that costs money while an account with allowance sits
 *    idle. Another account is strictly cheaper, so prefer one.
 *
 * Returns the instant the account should be reconsidered, or null when it is
 * fine. `resetsAt` is unix SECONDS in this payload, unlike everything else in
 * pidex.
 */
export function accountExhaustedUntil(
  statusText: string | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!statusText) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(statusText) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const utilization = typeof raw.utilization === 'number' ? raw.utilization : null
  const exhausted =
    raw.status === 'rejected' ||
    raw.isUsingOverage === true ||
    (utilization !== null && utilization >= 1)
  if (!exhausted) return null

  // A window that resets in the past is a stale report, not a free account.
  const resetsAt = typeof raw.resetsAt === 'number' && raw.resetsAt > 0 ? raw.resetsAt * 1000 : null
  if (resetsAt !== null && resetsAt <= nowMs) return null
  return resetsAt ?? nowMs + FIVE_HOURS_MS
}
