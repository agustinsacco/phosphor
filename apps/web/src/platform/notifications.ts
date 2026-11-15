import {
  notificationPayload,
  notificationPath,
  parseNotificationRoute,
  type NativeNotice,
} from '@phosphor/shared/notifications'

export interface BrowserNotificationPorts {
  hidden(): boolean
  permission(): NotificationPermission | 'unavailable'
  registration(): Promise<ServiceWorkerRegistration | undefined>
}
const defaults: BrowserNotificationPorts = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  permission: () => (typeof Notification === 'undefined' ? 'unavailable' : Notification.permission),
  registration: () =>
    globalThis.navigator?.serviceWorker?.getRegistration() ?? Promise.resolve(undefined),
}

/** Browser notifications outlive this invocation: false means no synchronous click result, not failure. */
export function createBrowserNotifications(ports: BrowserNotificationPorts = defaults) {
  return {
    async notify(notice: NativeNotice): Promise<boolean> {
      if (!ports.hidden() || ports.permission() !== 'granted') return false
      try {
        const registration = await ports.registration()
        if (!registration || !ports.hidden() || ports.permission() !== 'granted') return false
        const payload = notificationPayload(notice)
        await registration.showNotification(payload.title, payload.options)
      } catch {
        // Notification delivery is optional; the in-app notice remains in the drawer.
      }
      return false
    },
    async attention(notice: NativeNotice, current: () => boolean): Promise<void> {
      if (ports.permission() !== 'granted') return
      try {
        const registration = await ports.registration()
        if (current() && ports.permission() === 'granted')
          registration?.active?.postMessage({ type: 'phosphor-attention', notice })
      } catch {
        // Worker missing or unavailable: in-app attention still works.
      }
    },
  }
}

/** Accept routes only from this origin's worker; navigation still passes through normal Host grants. */
export function attachNotificationClicks(navigate: (path: string) => void): () => void {
  const workers = globalThis.navigator?.serviceWorker
  if (!workers) return () => {}
  const listener = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.data?.type !== 'phosphor-notification') return
    const route = parseNotificationRoute(event.data.route)
    if (event.data.route !== undefined && !route) return
    navigate(notificationPath(route))
  }
  workers.addEventListener('message', listener)
  return () => workers.removeEventListener('message', listener)
}

export function navigateNotification(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
