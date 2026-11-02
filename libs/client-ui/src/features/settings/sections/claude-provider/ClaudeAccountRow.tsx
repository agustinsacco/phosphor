import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { ChevronIcon } from '@/components/icons'
import { usageTextClass, windowResetLabel } from '@/lib/claudeUsage'
import { signInState, type ClaudeAccountModel } from '../accounts/accountsModel'
import { SignInPill } from '../accounts/SignInPill'

const laneCount = (count: number, live: boolean): string => {
  const noun = live ? 'live session' : 'lane'
  return count === 0 ? `no ${noun}` : `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * One account: identity, quota, order and its actions; opened, that account's
 * own usage and the lanes spending it (`children`).
 *
 * The disclosure is what makes this a gateway rather than a list. Usage is
 * per credential, so the numbers sit under the account they belong to, and
 * the lanes billing it sit under the same fold.
 */
export function ClaudeAccountRow({
  account,
  live,
  pin,
  expanded,
  onToggle,
  children,
  actions,
}: {
  account: ClaudeAccountModel
  /** Lanes are live sessions here, saved and running lanes elsewhere. */
  live: boolean
  /** The pin radio, while routing uses one account. */
  pin?: { checked: boolean; disabled: boolean; onPin: () => void }
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  actions: React.ReactNode
}): React.JSX.Element {
  const fiveHour = account.usage?.windows.find((w) => w.kind === 'five_hour')
  const reset = fiveHour ? windowResetLabel(fiveHour.resetsAt) : null
  return (
    <div className="px-3.5 py-2.5" data-account-id={account.id}>
      <div className="flex items-start gap-3">
        {pin && (
          <input
            type="radio"
            name="claude-pinned-account"
            aria-label={`Use ${account.label} for new sessions`}
            className="accent-accent mt-1.5"
            checked={pin.checked}
            disabled={pin.disabled}
            onChange={pin.onPin}
            data-tooltip={`Use ${account.label} for new sessions`}
          />
        )}
        <TooltipButton
          type="button"
          onClick={onToggle}
          tooltip={expanded ? 'Hide account details' : 'Show account details'}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-1.5 text-base font-medium">
            <ChevronIcon expanded={expanded} className="text-text-tertiary" />
            {account.label}
            <SignInPill state={signInState(account.signedIn)} />
            <span className="text-text-tertiary text-sm font-normal">
              {laneCount(account.lanes.length, live)}
            </span>
          </div>
          {account.detail && (
            <div className="text-text-tertiary truncate font-mono text-sm">{account.detail}</div>
          )}
          {fiveHour && (
            <div className={clsx('mt-0.5 font-mono text-sm', usageTextClass(fiveHour.percentUsed))}>
              5-hour {Math.round(fiveHour.percentUsed)}% used{reset ? ` · ${reset}` : ''}
            </div>
          )}
          {account.cooldownUntil !== null && (
            <div className="text-warning mt-0.5 text-sm">
              Skipped by routing until this window resets.
            </div>
          )}
        </TooltipButton>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {expanded && children}
    </div>
  )
}

/** Reorder, sign in again, remove. Remove waits while lanes on the account are running. */
export function ClaudeAccountActions({
  account,
  index,
  count,
  busy,
  onMove,
  onReauth,
  onRemove,
}: {
  account: ClaudeAccountModel
  index: number
  count: number
  busy: boolean
  onMove: (index: number, delta: number) => void
  onReauth: () => void
  onRemove: () => void
}): React.JSX.Element {
  const running = account.lanes.some((lane) => lane.active)
  const quiet = 'text-text-secondary hover:text-text text-base disabled:opacity-40'
  return (
    <>
      <TooltipButton
        onClick={() => onMove(index, -1)}
        disabled={busy || index === 0}
        aria-label={`Move ${account.label} up`}
        className={clsx(quiet, 'px-1')}
      >
        ↑
      </TooltipButton>
      <TooltipButton
        onClick={() => onMove(index, 1)}
        disabled={busy || index === count - 1}
        aria-label={`Move ${account.label} down`}
        className={clsx(quiet, 'px-1')}
      >
        ↓
      </TooltipButton>
      <TooltipButton onClick={onReauth} disabled={busy} className={quiet}>
        Sign in again
      </TooltipButton>
      <TooltipButton
        onClick={onRemove}
        disabled={busy || running}
        tooltip={running ? 'Stop or move the lanes running on this account first' : undefined}
        className="text-danger text-base hover:underline disabled:opacity-40"
      >
        Remove
      </TooltipButton>
    </>
  )
}
