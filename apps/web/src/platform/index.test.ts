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
    resources: { machines: proxy, repositories: proxy, ...proxy },
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
      get: (_t, key) => (key === 'machines' || key === 'repositories' ? proxy : noop),
    }),
    prefs: proxy,
    drafts: proxy,
  } as never)
  for (const handler of Object.values(concrete)) expect(typeof handler).toBe('function')
})
it('persists only an allowlisted theme; preferences never include account/session material', () => {
  const storage = {
    getItem: vi.fn(() =>
      JSON.stringify({ theme: 'light', csrfToken: 'secret', drafts: { private: 'prompt' } }),
    ),
    setItem: vi.fn(),
  }
  const prefs = createBrowserPreferences(storage)
  expect(prefs.get().theme).toBe('light')
  expect(prefs.get().drafts).toEqual({})
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
