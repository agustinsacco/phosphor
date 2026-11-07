import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'

const A = '11111111-1111-4111-8111-111111111111'
const SIDEBAR_KEY = 'phosphor.web.sidebar.v1'
const ORDER = ['host:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0123456789abcdef']
const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
  }
}
/** A browser bridge whose session read answers as `user` (or signed out when null). */
function bridge(storage: ReturnType<typeof memoryStorage>, user: () => string | null) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (path) => {
    const id = user()
    if (path === '/api/auth/session')
      return id
        ? json({ user: { id, login: 'fixture' }, clientId: id, csrfToken: id.replace(/-/g, '') })
        : new Response('', { status: 401 })
    if (path === '/api/v1/machines')
      return json({ machines: [], serverTime: new Date().toISOString() })
    return json({ signedOut: true, remoteCleanup: 'complete' })
  })
  const adapter = createBrowserApi({
    fetch,
    storage,
    navigate: () => {},
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
  })
  disposals.push(adapter.dispose)
  return adapter
}

it('keeps the sidebar order across a reload for the same signed-in owner', async () => {
  const storage = memoryStorage()
  const first = bridge(storage, () => A)
  await first.start()
  await first.api.invoke('app:setSessionOrder', ORDER)
  // A reload: the page goes away without disposing, and a new bridge starts.
  const reloaded = bridge(storage, () => A)
  await reloaded.start()
  expect((await reloaded.api.invoke('app:getPrefs')).sessionOrder).toEqual(ORDER)
})
