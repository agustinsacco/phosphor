import { useEffect } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { BellIcon } from '@/components/icons'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { unseenCount, useNotificationsStore } from '@/stores/notifications'

/** How often aged-out notices leave the list. */
const AGING_TICK_MS = 60_000

/**
 * Opens or closes the drawer. Opening takes the cards already on screen with
 * it: each is a row in the drawer now, and two copies of one notice is noise.
 */
export function setNotificationsOpen(open: boolean): void {
  useNotificationsStore.getState().setOpen(open)
  if (!open) return
  const toasts = useExtensionUiStore.getState()
  for (const toast of toasts.toasts) if (toast.noticeId) toasts.dismissToast(toast.id)
}

/**
 * The top bar's bell, at its right end: the count of new notices, and the
 * switch for the drawer. It also runs the aging clock, since the bar is
 * always mounted and the drawer is not.
 */
export function NotificationsButton(): React.JSX.Element {
  const count = useNotificationsStore(unseenCount)
  const open = useNotificationsStore((s) => s.open)
  useEffect(() => {
    const timer = setInterval(() => useNotificationsStore.getState().prune(), AGING_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const label = count > 0 ? `Notifications, ${count} new` : 'Notifications'
  return (
    <div className="relative">
      <TooltipButton
        title={label}
        aria-label={label}
        aria-pressed={open}
        data-testid="notifications-button"
        onClick={() => setNotificationsOpen(!open)}
        className={clsx(
          'titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
          open
            ? 'bg-accent-soft text-accent'
            : 'text-text-tertiary hover:text-text hover:bg-bg-secondary',
        )}
      >
        <BellIcon size={15} />
      </TooltipButton>
      {count > 0 && (
        <span className="bg-accent text-accent-text pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-2xs font-bold tabular-nums">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </div>
  )
}
