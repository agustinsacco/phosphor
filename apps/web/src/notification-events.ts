import {
  notificationPath,
  notificationPayload,
  parseNotificationRoute,
  type NativeNotice,
} from '@phosphor/shared/notifications'

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
  client.postMessage({ type: 'phosphor-notification', ...(route ? { route } : {}) })
}
