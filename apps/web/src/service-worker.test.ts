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
  runInNewContext(output.outputFiles[0]!.text, {
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
    location: { origin: 'https://app.invalid' },
    clients: { claim: vi.fn() },
    caches,
    fetch,
    URL,
    Request,
    Response,
  })
  return { listeners, cache, caches, fetch }
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
