import { useEffect, useRef } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { NotificationDrawer } from '@/features/notifications/NotificationDrawer'
import { NotificationPermissionOffer } from '@/features/notifications/NotificationPermission'
import { setNotificationsOpen } from '@/features/notifications/NotificationsButton'
import { useNotificationsStore } from '@/stores/notifications'
import { usePlatform } from '@/platform/Platform'
import './browserNotifications.css'

export function BrowserNotifications(): React.JSX.Element | null {
  const open = useNotificationsStore((s) => s.open)
  const compact = usePlatform().formFactor === 'compact'
  if (!open) return null
  const drawer = (
    <NotificationDrawer
      className="browser-notifications"
      permission={<NotificationPermissionOffer />}
      onNavigate={
        compact ? () => useNotificationsStore.getState().closeAfterNavigation() : undefined
      }
    />
  )
  return compact ? (
    <ModalOverlay onClose={() => setNotificationsOpen(false)}>
      <NotificationSheet>{drawer}</NotificationSheet>
    </ModalOverlay>
  ) : (
    drawer
  )
}

/** Keep keyboard focus inside the phone sheet and return it to the bell on close. */
function NotificationSheet({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Notifications"
      className="notification-sheet"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = [
          ...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ]
        const first = buttons[0],
          last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      {children}
    </div>
  )
}
