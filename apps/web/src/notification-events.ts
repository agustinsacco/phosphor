import {
  notificationPath,
  notificationPayload,
  parseNotificationRoute,
  pushNotice,
  type NativeNotice,
} from '@phosphor/shared/notifications'
import { parseWebPushPayload } from '@phosphor/shared/host-protocol-web-push'

/** A visible page showing this lane is the browser equivalent of Desktop's focused window. */
export async function showHostNotification(worker: ServiceWorkerGlobalScope, notice: NativeNotice) {
  const route = parseNotificationRoute(notice.route)
  if (!route) return
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const lanePath = `/lanes/${route.hostId}/${route.laneId}`
  if (
    clients.some((client) => {
      const url = new URL(client.url)
      return (
        url.origin === worker.location.origin &&
        client.visibilityState === 'visible' &&
        (url.pathname === lanePath || url.pathname.startsWith(`${lanePath}/`))
      )
    })
  )
    return
  const payload = notificationPayload(notice)
  await worker.registration.showNotification(payload.title, payload.options)
}

/**
 * A Host's Web Push. A visible page of the app already has the lane's attention, in the
 * app and natively, so the push shows nothing; otherwise it shows the page's notice, with
 * the same tag, so the two never stack.
 */
export async function showPushNotification(worker: ServiceWorkerGlobalScope, data: unknown) {
  const payload = parseWebPushPayload(data)
  if (!payload) return
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (
    clients.some(
      (client) =>
        new URL(client.url).origin === worker.location.origin &&
        client.visibilityState === 'visible',
    )
  )
    return
  const notice = notificationPayload(pushNotice(payload))
  await worker.registration.showNotification(notice.title, notice.options)
}

export async function openNotification(worker: ServiceWorkerGlobalScope, data: unknown) {
  if (
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== 'phosphor-notification'
  )
    return
  const route = parseNotificationRoute('route' in data ? data.route : undefined)
  if ('route' in data && !route) return
  const path = notificationPath(route)
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const sameOrigin = clients.filter(
    (client) => new URL(client.url).origin === worker.location.origin,
  )
  const client =
    sameOrigin.find((client) => new URL(client.url).pathname === path.split('?')[0]) ??
    sameOrigin[0]
  if (!client) {
    await worker.clients.openWindow(path)
    return
  }
  await client.focus()
  if (route) client.postMessage({ type: 'phosphor-notification', route })
}
