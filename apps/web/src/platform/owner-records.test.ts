import { afterEach, expect, it, vi } from 'vitest'
import { sha256Hex } from '@phosphor/host-client/crypto'
import { createBrowserApi } from './index'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const OWNER_KEY = 'phosphor.web.owner.v1'
const APPEARANCE_KEY = 'phosphor.web.appearance.v1'
const tag = (id: string) => sha256Hex(new TextEncoder().encode(`phosphor.web.owner.v1\0${id}`))
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
function bridge(
  storage: ReturnType<typeof memoryStorage>,
  user: () => string | null,
  { reload = vi.fn(), client = (id: string) => id } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (path) => {
    const id = user()
    if (path === '/api/auth/session')
      return id
        ? json({
            user: { id, login: 'fixture' },
            clientId: client(id),
            csrfToken: client(id).replace(/-/g, ''),
          })
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
    reload,
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

/** Storage holding A's sidebar order, tagged as A's, and a device theme. */
async function storedForA() {
  return memoryStorage({
    [OWNER_KEY]: await tag(A),
    [SIDEBAR_KEY]: JSON.stringify({ sessionOrder: ORDER, collapsedWorkspaces: [] }),
    [APPEARANCE_KEY]: JSON.stringify({ theme: 'dark' }),
  })
}
const sidebarIn = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.items.get(SIDEBAR_KEY) ?? '{}') as { sessionOrder?: string[] }

it("never shows A's order to B: withheld before the check, cleared and re-tagged after it", async () => {
  const storage = await storedForA()
  const adapter = bridge(storage, () => B)
  expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual([])
  await adapter.start()
  const prefs = await adapter.api.invoke('app:getPrefs')
  expect(prefs.sessionOrder).toEqual([])
  expect(prefs.theme).toBe('dark')
  expect(sidebarIn(storage).sessionOrder).toEqual([])
  expect(storage.items.get(OWNER_KEY)).toBe(await tag(B))
  expect([...storage.items.values()].join()).not.toContain(B)
})

it('clears the owner records when the browser is signed out on load', async () => {
  const storage = await storedForA()
  await bridge(storage, () => null).start()
  expect(sidebarIn(storage).sessionOrder).toEqual([])
  expect(storage.items.get(OWNER_KEY)).toBe('')
  expect(JSON.parse(storage.items.get(APPEARANCE_KEY)!)).toEqual({ theme: 'dark' })
})

it('sign-out clears the owner records and drops the tag', async () => {
  const storage = await storedForA()
  const adapter = bridge(storage, () => A)
  await adapter.start()
  expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual(ORDER)
  await adapter.api.invoke('account:signOut')
  expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual([])
  expect(sidebarIn(storage).sessionOrder).toEqual([])
  expect(storage.items.get(OWNER_KEY)).toBe('')
})

it('treats the owner as unknown, and clears, without platform crypto', async () => {
  const storage = await storedForA()
  vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined })
  try {
    const adapter = bridge(storage, () => A)
    await adapter.start()
    expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
  expect(sidebarIn(storage).sessionOrder).toEqual([])
  expect(storage.items.get(OWNER_KEY)).toBe('')
})

it("reloads once, and writes none of A's keys under B's tag, when B signs in on an open page", async () => {
  const storage = memoryStorage()
  const reload = vi.fn()
  let user: string | null = A
  const adapter = bridge(storage, () => user, { reload })
  await adapter.start()
  await adapter.api.invoke('app:setSessionOrder', ORDER)
  user = null
  await adapter.start()
  user = B
  await adapter.start()
  // The page's stores still hold A's arrangement and write it back.
  await adapter.api.invoke('app:setSessionOrder', ORDER)
  await adapter.api.invoke('app:setCollapsedWorkspaces', ORDER)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(storage.items.get(OWNER_KEY)).toBe(await tag(B))
  expect(storage.items.get(SIDEBAR_KEY)).not.toContain(ORDER[0])
  expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual([])
})

/** A bridge that sees `owners` in turn on one open page, then writes A's order back. */
async function openPage(owners: (string | null)[], options: Parameters<typeof bridge>[2] = {}) {
  const storage = await storedForA()
  const appearance = storage.items.get(APPEARANCE_KEY)
  let user = owners[0] ?? null
  const adapter = bridge(storage, () => user, options)
  for (const owner of owners) {
    user = owner
    await adapter.start()
    await adapter.api.invoke('app:getPrefs')
  }
  await adapter.api.invoke('app:setSessionOrder', ORDER)
  expect(storage.items.get(APPEARANCE_KEY)).toBe(appearance)
  return { storage, adapter }
}

it.each([
  ['a fresh load', [A]],
  ['A, signed out, then A', [A, null, A]],
  ['signed out, then A', [null, A]],
])('does not reload, and keeps the write, for %s', async (_, owners) => {
  const reload = vi.fn()
  const { storage } = await openPage(owners, { reload })
  expect(reload).not.toHaveBeenCalled()
  expect(sidebarIn(storage).sessionOrder).toEqual(ORDER)
})

it('does not reload for the same owner with a new client id and CSRF token', async () => {
  const reload = vi.fn()
  let session = 0
  const { storage } = await openPage([A, A], {
    reload,
    client: (id) => `${id.slice(0, -2)}${++session}0`,
  })
  expect(session).toBeGreaterThan(1)
  expect(reload).not.toHaveBeenCalled()
  expect(sidebarIn(storage).sessionOrder).toEqual(ORDER)
})

it('reloads at most once and keeps dropping writes when the reload fails', async () => {
  const reload = vi.fn(() => {
    throw new Error('Reload blocked.')
  })
  const { storage, adapter } = await openPage([A, B, null, A], { reload })
  expect(reload).toHaveBeenCalledTimes(1)
  expect(sidebarIn(storage).sessionOrder).toEqual([])
  expect((await adapter.api.invoke('app:getPrefs')).sessionOrder).toEqual([])
})
