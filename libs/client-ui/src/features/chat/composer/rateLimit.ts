/**
 * Account rate-limit state, as reported by the Claude Code provider
 * (`@saccolabs/pi-claude-cli` ≥ 0.4.5) over pi's status channel.
 *
 * Present only for sessions served by that provider — every other provider
 * simply never pushes this key, so the UI shows nothing rather than an
 * empty section.
 *
 * ONE window per event, not a dashboard. The CLI reports the first window
 * whose warning threshold has been crossed, walking
 * `5h -> 7d -> 7d_oi -> overage`, so what arrives is the *binding constraint* —
 * the limit that will actually stop you — and the other windows are simply not
 * on this stream. Rendering it as "the" limit is honest; rendering four bars
 * from it would not be.
 *
 * `utilization` arrives from provider ≥ 0.4.9. Older providers send the window
 * and its reset but no percentage, so the bar is omitted rather than guessed.
 */

export const RATE_LIMIT_STATUS_KEY = 'claude-rate-limit'

export interface ClaudeRateLimit {
  /** "allowed" while requests are being served; "rejected" when capped. */
  status: string | null
  /** Unix seconds when the window resets, when known. */
  resetsAt: number | null
  /** e.g. "five_hour". */
  windowType: string | null
  isUsingOverage: boolean
  overageStatus: string | null
  /**
   * Fraction of the window consumed: 1.01 means 101%, i.e. over.
   * `null` on providers older than 0.4.9, which never sent it.
   */
  utilization: number | null
}

export function parseRateLimit(statusText: string | undefined): ClaudeRateLimit | null {
  if (!statusText) return null
  try {
    const raw = JSON.parse(statusText) as Record<string, unknown>
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    const resetsAt = typeof raw.resetsAt === 'number' && raw.resetsAt > 0 ? raw.resetsAt : null
    const status = str(raw.status)
    const windowType = str(raw.rateLimitType)
    // A payload with none of the three useful fields is not worth a section.
    if (!status && !resetsAt && !windowType) return null
    return {
      status,
      resetsAt,
      windowType,
      isUsingOverage: raw.isUsingOverage === true,
      overageStatus: str(raw.overageStatus),
      // Absent on older providers. Kept as null rather than 0 — "unknown" and
      // "none used" must not look the same in the UI.
      utilization:
        typeof raw.utilization === 'number' && Number.isFinite(raw.utilization)
          ? raw.utilization
          : null,
    }
  } catch {
    return null
  }
}

/** "five_hour" → "5-hour limit"; unknown types pass through readably. */
export function windowLabel(windowType: string | null): string {
  switch (windowType) {
    case 'five_hour':
      return '5-hour limit'
    case 'seven_day':
      return 'Weekly limit'
    case 'seven_day_oauth_apps':
      return 'Weekly limit (apps)'
    case 'seven_day_overage_included':
      return 'Weekly limit (incl. credits)'
    // Not a plan window at all: pay-as-you-go usage credits, billed at
    // standard API rates on top of the subscription. Saying "overage limit"
    // hid that this one costs real money per token.
    case 'overage':
      return 'Usage credits'
    default:
      return windowType ? windowType.replace(/_/g, ' ') : 'Usage limit'
  }
}

/** "101%" — or null when the provider is too old to report it. */
export function utilizationPercent(utilization: number | null): number | null {
  if (utilization === null) return null
  return Math.max(0, Math.round(utilization * 100))
}

/**
 * Whether this window costs money per token rather than consuming an
 * allowance. `overage` is the usage-credit bucket: billed at standard API
 * rates, charged separately from the subscription.
 */
export function isPaidWindow(windowType: string | null): boolean {
  return windowType === 'overage'
}

/**
 * "Resets in 2 hr 24 min" or "Resets in 1d 2h" for longer windows. Returns
 * null once the reset has passed, since a stale countdown is worse than no
 * countdown — the next turn re-reports.
 */
export function resetLabel(resetsAt: number | null, nowMs: number = Date.now()): string | null {
  if (resetsAt === null) return null
  const seconds = resetsAt - Math.floor(nowMs / 1000)
  if (seconds <= 0) return null
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (days > 0) return `Resets in ${days}d ${hours}h`
  if (hours > 0) return `Resets in ${hours} hr${minutes > 0 ? ` ${minutes} min` : ''}`
  return `Resets in ${Math.max(1, minutes)} min`
}

/**
 * Whether this window's state is worth interrupting the user for, rather
 * than leaving it to the opt-in popup. Mirrors the popup's own warn/danger
 * thresholds (`ContextMeter.tsx`'s `PlanLimits`) so the two surfaces can
 * never disagree about what counts as urgent.
 *
 * A window whose reset has already passed is stale — the CLI just hasn't
 * sent a fresh event yet — and a warning that outlives its own window is
 * worse than no warning.
 */
export function needsAttention(limit: ClaudeRateLimit, nowMs: number = Date.now()): boolean {
  if (limit.resetsAt !== null && limit.resetsAt <= Math.floor(nowMs / 1000)) return false
  if (limit.status === 'rejected') return true
  const percent = utilizationPercent(limit.utilization)
  return percent !== null && percent >= 75
}
