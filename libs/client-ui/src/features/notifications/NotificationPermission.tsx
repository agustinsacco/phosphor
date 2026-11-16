import { Button } from '@/components/form'
import { useNotificationPermission } from '@/platform/useNotificationPermission'

/** A quiet invitation, never an automatic browser prompt. */
export function NotificationPermissionOffer(): React.JSX.Element | null {
  const { permission, request, error } = useNotificationPermission()
  if (permission !== 'default') return null
  return (
    <div className="border-border text-text-secondary mb-2 border-b px-2 py-3 text-sm">
      <p>Get notified when a lane needs you</p>
      <Button className="mt-2" onClick={request}>
        Turn on
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
