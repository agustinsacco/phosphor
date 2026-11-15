import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

async function fixture() {
  const listeners = new Map<string, (event: unknown) => void>()
  const cache = { put: vi.fn(), keys: vi.fn(async () => []), match: vi.fn(), delete: vi.fn() }
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => []), delete: vi.fn() }
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('static shell'))
  const output = await build({
    entryPoints: ['apps/web/src/service-worker.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { __WEB_BUILD_ID__: '"test"' },
  })
  const clients = {
    claim: vi.fn(),
    matchAll: vi.fn<() => Promise<object[]>>(async () => []),
    openWindow: vi.fn(async (_path: string) => null),
  }
  const registration = { showNotification: vi.fn(async () => {}) }
  runInNewContext(output.outputFiles[0]!.text, {
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
    location: { origin: 'https://app.invalid' },
    clients,
    registration,
    caches,
    fetch,
    URL,
    Request,
    Response,
  })
  return { listeners, cache, caches, fetch, clients, registration }
}
it.each([
  ['https://app.invalid/api/auth/session', 'GET', 'cors'],
  ['https://app.invalid/api/v1/grants', 'POST', 'cors'],
  ['https://app.invalid/api', 'GET', 'navigate'],
  ['https://app.invalid/api/auth/callback?code=fixture', 'GET', 'navigate'],
  ['https://app.invalid/assets/file-abcdef.js', 'POST', 'cors'],
  ['https://host.tail.ts.net:47615/assets/file-abcdef.js', 'GET', 'cors'],
  ['https://host.tail.ts.net:47615/v1/hello', 'GET', 'cors'],
  ['https://app.invalid/lanes/private.json', 'GET', 'cors'],
  ['https://app.invalid/assets/file-abcdef.js?grant=private', 'GET', 'cors'],
])('never intercepts private or unsupported request %s', async (url, method, mode) => {
  const t = await fixture()
  const respondWith = vi.fn()
  t.listeners.get('fetch')!({ request: { url, method, mode }, respondWith, waitUntil: vi.fn() })
  expect(respondWith).not.toHaveBeenCalled()
  expect(t.fetch).not.toHaveBeenCalled()
  expect(t.caches.open).not.toHaveBeenCalled()
})
it('installs only anonymous fixed shell resources without forced activation', async () => {
  const t = await fixture()
  let pending!: Promise<unknown>
  t.listeners.get('install')!({
    waitUntil: (value: Promise<unknown>) => {
      pending = value
    },
  })
  await pending
  expect(t.fetch.mock.calls.map((call) => call[0])).toEqual([
    '/',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
  ])
  for (const call of t.fetch.mock.calls)
    expect(call[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  expect(t.cache.put).toHaveBeenCalledTimes(3)
})
it('does not cache successful navigations, and falls back to anonymous shell only offline', async () => {
  const t = await fixture()
  let response!: Promise<Response>
  const event = {
    request: { url: 'https://app.invalid/hosts/example', method: 'GET', mode: 'navigate' },
    respondWith: (value: Promise<Response>) => {
      response = value
    },
  }
  t.listeners.get('fetch')!(event)
  expect(await (await response).text()).toBe('static shell')
  expect(t.cache.put).not.toHaveBeenCalled()
  t.fetch.mockRejectedValueOnce(new Error('offline'))
  t.cache.match.mockResolvedValueOnce(new Response('anonymous offline shell'))
  t.listeners.get('fetch')!(event)
  expect(await (await response).text()).toBe('anonymous offline shell')
  expect(t.cache.match).toHaveBeenCalledWith('/')
  expect(t.cache.put).not.toHaveBeenCalled()
})

const route = { hostId: 'host', laneId: 'lane' }
const notificationData = { type: 'phosphor-notification', route }
function client(path: string, visibilityState = 'visible') {
  return {
    url: `https://app.invalid${path}`,
    visibilityState,
    focus: vi.fn(async () => {}),
    postMessage: vi.fn(),
  }
}
async function dispatch(t: Awaited<ReturnType<typeof fixture>>, name: string, data: object) {
  let pending: Promise<unknown> | undefined
  t.listeners.get(name)!({
    ...data,
    waitUntil: (work: Promise<unknown>) => {
      pending = work
    },
  })
  await pending
}
it('notificationclick closes the notice, focuses an existing page and sends its opaque route', async () => {
  const t = await fixture()
  const other = client('/lanes'),
    lane = client('/lanes/host/lane/chat')
  t.clients.matchAll.mockResolvedValue([other, lane])
  const close = vi.fn()
  await dispatch(t, 'notificationclick', { notification: { data: notificationData, close } })
  expect(close).toHaveBeenCalledOnce()
  expect(lane.focus).toHaveBeenCalledOnce()
  expect(other.focus).not.toHaveBeenCalled()
  expect(lane.postMessage).toHaveBeenCalledWith(notificationData)
  expect(t.clients.openWindow).not.toHaveBeenCalled()
})
it('notificationclick opens a same-origin lane or Home when no client exists, including PR focus', async () => {
  const t = await fixture()
  const pr = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
  await dispatch(t, 'notificationclick', {
    notification: { data: { ...notificationData, route: { ...route, pr } }, close: vi.fn() },
  })
  expect(t.clients.openWindow).toHaveBeenLastCalledWith(
    `/lanes/host/lane/chat?notificationPr=${encodeURIComponent(JSON.stringify(pr))}`,
  )
  await dispatch(t, 'notificationclick', {
    notification: { data: { type: 'phosphor-notification' }, close: vi.fn() },
  })
  expect(t.clients.openWindow).toHaveBeenLastCalledWith('/lanes')
})
it('notificationclick can reuse another app page but never focuses a foreign origin or follows a path payload', async () => {
  const t = await fixture()
  const app = client('/pages/settings')
  const foreign = { ...client('/'), url: 'https://other.invalid/lanes/host/lane/chat' }
  t.clients.matchAll.mockResolvedValue([foreign, app])
  await dispatch(t, 'notificationclick', {
    notification: { data: notificationData, close: vi.fn() },
  })
  expect(app.focus).toHaveBeenCalledOnce()
  expect(foreign.focus).not.toHaveBeenCalled()
  await dispatch(t, 'notificationclick', {
    notification: {
      data: { ...notificationData, route: { ...route, laneId: '../private' } },
      close: vi.fn(),
    },
  })
  expect(app.focus).toHaveBeenCalledOnce()
})
it.each([
  ['/lanes/host/lane/chat', 'visible', false],
  ['/lanes/host/lane/files', 'visible', false],
  ['/lanes/host/lane/chat', 'hidden', true],
  ['/lanes/host/another/chat', 'visible', true],
  ['/pages/settings', 'visible', true],
] as const)('Host attention on %s (%s): native delivery = %s', async (path, visibility, shown) => {
  const t = await fixture()
  t.clients.matchAll.mockResolvedValue([client(path, visibility)])
  await dispatch(t, 'message', {
    data: { type: 'phosphor-attention', notice: { title: 'bee1 · Lane', body: 'Done', route } },
  })
  expect(t.registration.showNotification).toHaveBeenCalledTimes(shown ? 1 : 0)
  if (shown)
    expect(t.registration.showNotification).toHaveBeenCalledWith(
      'bee1 · Lane',
      expect.objectContaining({
        body: 'Done',
        tag: 'phosphor:lane:host:lane',
        data: notificationData,
      }),
    )
})
it('Host attention is suppressed if any visible client shows the lane and ignores malformed messages', async () => {
  const t = await fixture()
  t.clients.matchAll.mockResolvedValue([client('/lanes'), client('/lanes/host/lane/chat')])
  await dispatch(t, 'message', {
    data: { type: 'phosphor-attention', notice: { title: 'bee1 · Lane', body: 'Done', route } },
  })
  await dispatch(t, 'message', { data: { type: 'phosphor-attention', notice: { title: 'Bad' } } })
  expect(t.registration.showNotification).not.toHaveBeenCalled()
})
