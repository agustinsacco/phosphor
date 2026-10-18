declare const __WEB_BUILD_ID__: string
const worker = globalThis as unknown as ServiceWorkerGlobalScope
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
