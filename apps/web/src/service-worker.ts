import { openNotification, showHostNotification, showPushNotification } from './notification-events'
import { isPushScope } from './push-scope'
declare const __WEB_BUILD_ID__: string
const worker = globalThis as unknown as ServiceWorkerGlobalScope
/**
 * A Host's push registration controls no page and activates at once on every deploy, so it
 * never caches, never deletes caches older tabs still use, and never claims a client.
 */
const PUSH_ONLY = isPushScope(worker.registration?.scope)
const PREFIX = 'phosphor-web-shell-'
const CACHE = PREFIX + __WEB_BUILD_ID__
const STATIC = ['/', '/icons/icon-192.png', '/icons/icon-512.png']
const ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|png|svg|webp)$/

async function remember(request: RequestInfo, response: Response) {
  if (response.status !== 200 || response.redirected) return
  const cache = await caches.open(CACHE)
  await cache.put(request, response)
  const keys = await cache.keys()
  const assets = keys.filter((key) => new URL(key.url).pathname.startsWith('/assets/'))
  for (const key of assets.slice(0, Math.max(0, assets.length - 64))) await cache.delete(key)
}
worker.addEventListener('install', (event) => {
  if (PUSH_ONLY) return
  event.waitUntil(
    Promise.all(
      STATIC.map(async (path) => {
        try {
          // Only anonymous static shell responses are eligible. Never cache a
          // navigation response, which could become personalized in a later server.
          const response = await fetch(path, {
            credentials: 'omit',
            cache: 'reload',
            redirect: 'error',
          })
          await remember(path, response)
        } catch {
          /* Installation is optional when storage or the network is unavailable. */
        }
      }),
    ),
  )
})
worker.addEventListener('activate', (event) => {
  if (PUSH_ONLY) return
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name)
      }
      await worker.clients.claim()
    })(),
  )
})
worker.addEventListener('fetch', (event) => {
  if (PUSH_ONLY) return
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== worker.location.origin) return
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        return (
          (await (await caches.open(CACHE)).match('/')) ??
          new Response('Phosphor is offline. Reconnect and reload.', { status: 503 })
        )
      }),
    )
    return
  }
  if (!ASSET.test(url.pathname) || url.search) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const existing = await cache.match(request)
      if (existing) return existing
      const response = await fetch(request, { credentials: 'omit', redirect: 'error' })
      event.waitUntil(remember(request, response.clone()).catch(() => {}))
      return response
    })(),
  )
})

worker.addEventListener('push', (event) => {
  let data: unknown
  try {
    data = event.data?.json()
  } catch {
    return
  }
  event.waitUntil(showPushNotification(worker, data).catch(() => {}))
})
worker.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openNotification(worker, event.notification.data))
})
worker.addEventListener('message', (event) => {
  if (
    event.data?.type !== 'phosphor-attention' ||
    typeof event.data.notice?.title !== 'string' ||
    typeof event.data.notice?.body !== 'string'
  )
    return
  event.waitUntil(showHostNotification(worker, event.data.notice).catch(() => {}))
})
