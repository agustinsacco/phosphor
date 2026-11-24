import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'
import { IPC_WEB } from '@phosphor/shared/ipc-web'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import { createBrowserHandlers } from './handlers'
import { createBrowserPreferences } from './preferences'
import { build } from 'esbuild'

const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 401 }))
  const socket = vi.fn()
  const adapter = createBrowserApi({
    fetch,
    socket,
    storage: null,
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
  })
  disposals.push(adapter.dispose)
  return { ...adapter, fetch, socket }
}
it('refuses every unsupported channel before any network call and never invents OS paths', async () => {
  const s = setup()
  for (const [channel, classification] of Object.entries(IPC_WEB))
    if (classification.kind === 'unsupported') {
      await expect(s.api.invoke(channel as IpcInvokeChannel, ...([] as never))).rejects.toThrow(
        classification.reason,
      )
    }
  expect(s.fetch).not.toHaveBeenCalled()
  expect(s.socket).not.toHaveBeenCalled()
  expect(s.api.pathForFile({ name: 'example.txt' } as File)).toBe('')
  expect(await s.api.piCommand('local-path', { type: 'get_messages' })).toMatchObject({
    success: false,
  })
})
it('has a concrete callable handler for exactly the supported classification', () => {
  const noop = () => undefined
  const proxy = new Proxy({}, { get: () => noop })
  const handlers = createBrowserHandlers({
    control: proxy,
    hosts: proxy,
    lanes: proxy,
    resources: { machines: proxy, repositories: proxy, folders: proxy, ...proxy },
    prefs: proxy,
    drafts: proxy,
  } as never)
  expect(Object.keys(handlers).sort()).toEqual(
    Object.entries(IPC_WEB)
      .filter(([, c]) => c.kind !== 'unsupported')
      .map(([key]) => key)
      .sort(),
  )
  // Missing bindings are not disguised as a successful generic fallback.
  const nested = new Proxy({}, { get: () => proxy })
  const concrete = createBrowserHandlers({
    control: proxy,
    hosts: proxy,
    lanes: proxy,
    resources: new Proxy(nested, {
      get: (_t, key) =>
        ['machines', 'repositories', 'folders'].includes(String(key)) ? proxy : noop,
    }),
    prefs: proxy,
    drafts: proxy,
  } as never)
  for (const handler of Object.values(concrete)) expect(typeof handler).toBe('function')
})
it('persists only an allowlisted theme; preferences never include account/session material', async () => {
  const storage = {
    getItem: vi.fn(() =>
      JSON.stringify({ theme: 'light', csrfToken: 'secret', drafts: { private: 'prompt' } }),
    ),
    setItem: vi.fn(),
  }
  const prefs = createBrowserPreferences(storage)
  expect((await prefs.read()).theme).toBe('light')
  expect((await prefs.read()).drafts).toEqual({})
  prefs.theme('dark')
  expect(storage.setItem).toHaveBeenCalledWith('phosphor.web.appearance.v1', '{"theme":"dark"}')
})
it('subscribes and cleans browser lifecycle and invalidation, broadcasting only logout', async () => {
  let invalidate!: () => void
  const off = vi.fn(),
    close = vi.fn(),
    publish = vi.fn()
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 401 }))
  const adapter = createBrowserApi({
    fetch,
    storage: null,
    lifecycle: { subscribe: () => off },
    invalidation: {
      subscribe: (cb) => {
        invalidate = cb
        return off
      },
      close,
      publish,
    },
  })
  disposals.push(adapter.dispose)
  await adapter.start()
  invalidate()
  expect(await adapter.api.invoke('hosts:snapshot')).toEqual({})
  await adapter.api.invoke('account:signOut')
  expect(publish).toHaveBeenCalledWith()
  adapter.dispose()
  expect(off).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
  await expect(adapter.api.invoke('account:get')).rejects.toThrow('disposed')
})
it('broadcasts sign-out only once it settles, and a receiving tab asks Control again', async () => {
  let receive!: () => void
  let settle: ((response: Response) => void) | undefined
  let signedIn = false
  const publish = vi.fn()
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn<typeof globalThis.fetch>(async (path) => {
    if (path === '/api/auth/signout')
      return new Promise<Response>((resolve) => {
        settle = resolve
      })
    if (path !== '/api/auth/session')
      return json({ machines: [], serverTime: new Date().toISOString() })
    if (!signedIn) return new Response('', { status: 401 })
    return json({
      user: { id: '11111111-1111-4111-8111-111111111111', login: 'fixture' },
      clientId: '22222222-2222-4222-8222-222222222222',
      csrfToken: 'a'.repeat(43),
    })
  })
  const adapter = createBrowserApi({
    fetch,
    storage: null,
    lifecycle: { subscribe: () => () => {} },
    invalidation: {
      subscribe: (cb) => {
        receive = cb
        return () => {}
      },
      close: () => {},
      publish,
    },
  })
  disposals.push(adapter.dispose)
  await adapter.start()
  const sessionChecks = () => fetch.mock.calls.filter(([path]) => path === '/api/auth/session')
  expect(sessionChecks()).toHaveLength(1)
  // Another tab signed out, then signed in again: this tab follows the server.
  signedIn = true
  receive()
  await vi.waitFor(() =>
    expect(adapter.api.invoke('account:get')).resolves.toMatchObject({
      account: { status: 'signed-in' },
    }),
  )
  const signOut = adapter.api.invoke('account:signOut')
  await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  expect(publish).not.toHaveBeenCalled()
  settle?.(json({ signedOut: true, remoteCleanup: 'complete' }))
  await signOut
  expect(publish).toHaveBeenCalledOnce()
})
it('starts during an outage instead of failing, and says the check is retrying', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new TypeError('Failed to fetch')
  })
  const adapter = createBrowserApi({
    fetch,
    storage: null,
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
  })
  disposals.push(adapter.dispose)
  await expect(adapter.start()).resolves.toBeUndefined()
  expect(await adapter.api.invoke('account:get')).toEqual({
    account: { status: 'signed-out', notice: 'unreachable' },
  })
})
it('bundles the production adapter without Node, Desktop, runtime or test dependencies', async () => {
  const result = await build({
    entryPoints: ['apps/web/src/platform/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    tsconfig: 'apps/web/tsconfig.platform.json',
  })
  expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([])
  for (const input of Object.keys(result.metafile!.inputs))
    expect(input).not.toMatch(/apps\/desktop|session-runtime|node:|\.test\./)
  expect(result.outputFiles[0]?.text).not.toMatch(/\bBuffer\b|\bprocess\.|node:|electron/)
})
