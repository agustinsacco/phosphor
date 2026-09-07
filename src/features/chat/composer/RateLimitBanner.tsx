import { useState } from 'react'
import clsx from 'clsx'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { CloseIcon } from '@/components/icons'
import {
  RATE_LIMIT_STATUS_KEY,
  needsAttention,
  parseRateLimit,
  resetLabel,
  utilizationPercent,
  windowLabel,
} from './rateLimit'
import { useSessionClaudeAccount } from './useSessionAccount'

/**
 * Account usage warning, directly above the composer.
 *
 * The context meter's popup already shows this window at any percentage,
 * opt-in — you have to click in to see it. This banner exists for the
 * moment that popup can't cover: crossing into the CLI's own warning
 * threshold while nobody's looking. It stays quiet otherwise; an
 * always-visible bar for a number that's fine 99% of the time is the same
 * alarm-fatigue mistake `LaneBanner` was rewritten to avoid.
 *
 * Dismiss is keyed to the exact reading shown. A later event that's worse
 * (higher percent, or newly capped) reopens the banner rather than staying
 * hidden behind a dismiss aimed at a milder state.
 */
export function RateLimitBanner({
  sessionId,
  className,
}: {
  sessionId: string
  className?: string
}): React.JSX.Element | null {
  const statusText = useExtensionUiStore((s) => s.statuses[sessionId]?.[RATE_LIMIT_STATUS_KEY])
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Only asked for once this banner is warranted, and only shown once more
  // than one account exists: with several logins in rotation, "limit reached"
  // is meaningless until you know whose limit.
  const { account } = useSessionClaudeAccount(sessionId, Boolean(statusText))

  const limit = parseRateLimit(statusText)
  if (!limit || !needsAttention(limit)) return null

  const percent = utilizationPercent(limit.utilization)
  const capped = limit.status === 'rejected'
  const over = percent !== null && percent >= 100
  const reset = resetLabel(limit.resetsAt)
  const signature = `${limit.windowType}:${limit.status}:${percent}`
  if (dismissed === signature) return null

  return (
    <div className={className}>
      <div
        className={clsx(
          'flex items-center gap-3 rounded-lg border px-3.5 py-2.5',
          capped || over ? 'bg-danger-soft border-danger/25' : 'bg-warning/10 border-warning/30',
        )}
      >
        <span
          className={clsx('text-lg font-medium', capped || over ? 'text-danger' : 'text-warning')}
        >
          {windowLabel(limit.windowType)}
        </span>
        <span className="text-text-secondary flex-1 truncate text-base">
          {percent !== null && `${percent}% used`}
          {capped ? ' · limit reached' : reset ? ` · ${reset}` : ''}
          {account && account.total > 1 && ` · ${account.email ?? account.label}`}
        </span>
        <button
          onClick={() => setDismissed(signature)}
          aria-label="Dismiss"
          className="text-text-tertiary hover:text-text shrink-0"
        >
          <CloseIcon size={11} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}
