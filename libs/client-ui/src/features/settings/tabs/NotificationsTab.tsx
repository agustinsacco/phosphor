import { useState } from 'react'
import { Button, Row, SectionTitle } from '@/components/form'
import { useNotificationPermission } from '@/platform/useNotificationPermission'
import { notificationPayload } from '@phosphor/shared/notifications'

/** Permission belongs to this browser/device, not to the machine selected in Configure. */
export function NotificationsTab(): React.JSX.Element {
  const { permission, request, error } = useNotificationPermission()
  const [testMessage, setTestMessage] = useState('')
  const state = permission === 'granted' ? 'On' : permission === 'denied' ? 'Blocked' : 'Off'
  const test = async (): Promise<void> => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration()
      if (!registration) throw new Error('No worker')
      const notice = notificationPayload({
        title: 'Phosphor',
        body: 'Notifications are on.',
        key: 'test',
      })
      await registration.showNotification(notice.title, notice.options)
      setTestMessage('Test notification sent.')
    } catch {
      setTestMessage('Could not send a test notification. Reload and try again.')
    }
  }
  return (
    <div>
      <SectionTitle>Notifications</SectionTitle>
      <Row
        title="Native notifications"
        description="Lane updates while the app runs. Delivery when closed needs Web Push."
      >
        <span>{state}</span>
      </Row>
      {permission === 'unavailable' ? (
        <p>
          Notifications are unavailable in this browser. On iPhone, install Phosphor on the Home
          Screen first.
        </p>
      ) : (
        <>
          {permission === 'denied' && (
            <p>Allow notifications in your browser’s site settings, then return here.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={permission !== 'default'} onClick={request}>
              Turn on notifications
            </Button>
            <Button
              disabled={permission !== 'granted'}
              onClick={() => {
                void test()
              }}
            >
              Send a test notification
            </Button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {testMessage && (
        <p role="status" className="mt-2">
          {testMessage}
        </p>
      )}
    </div>
  )
}
