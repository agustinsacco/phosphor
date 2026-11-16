import { useState } from 'react'
import { Button, Row, SectionTitle } from '@/components/form'
import { useNotificationPermission } from '@/platform/useNotificationPermission'
import { useMachinesStore } from '@/stores/machines'
import { canReadHost, connectionLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import { notificationPayload } from '@phosphor/shared/notifications'

/** Whether a machine will notify this device while Phosphor is closed. */
export function closedDelivery(host: HostConnectionView): string {
  if (host.pushRegistration === 'registered') return 'On'
  if (host.pushRegistration === 'failed') return 'Could not register'
  if (host.state !== 'ready') return connectionLabel(host.state)
  return host.webPushKey && canReadHost(host) ? 'Setting up' : 'Not supported'
}

/** Each Host registers this device on its own, so each one is listed with its own state. */
function ClosedDeliveryRow(): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const machines = useMachinesStore((s) => s.machines)
  const listed = machines.flatMap((machine) => {
    const host = hosts[machine.id]
    return host ? [{ id: machine.id, label: machine.label, status: closedDelivery(host) }] : []
  })
  return (
    <Row
      title="When Phosphor is closed"
      description="These machines notify this device through its push service."
    >
      {listed.length === 0 ? (
        <span>No machines</span>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {listed.map((machine) => (
            <li key={machine.id} className="flex justify-between gap-4">
              <span className="truncate">{machine.label}</span>
              <span className="text-text-tertiary">{machine.status}</span>
            </li>
          ))}
        </ul>
      )}
    </Row>
  )
}

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
        description="Lane updates on this device, also while Phosphor is closed."
      >
        <span>{state}</span>
      </Row>
      {permission === 'granted' && <ClosedDeliveryRow />}
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
