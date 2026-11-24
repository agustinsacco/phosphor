import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'
import { createBrowserPush, type PushPorts } from './push'

const ORIGIN = 'https://app.invalid'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const NEW_CLIENT = '00000000-0000-4000-8000-000000000015'
const MAC = '00000000-0000-4000-8000-000000000006'
const OLD = '00000000-0000-4000-8000-000000000007'
const KEY = 'B' + 'A'.repeat(86)
const OTHER_KEY = 'B' + 'A'.repeat(85) + 'Q'
const P256DH =
  'BLovIndJxi9rn_Q4YZsHtnESnX2ccbijmaIDmUM5wlGXFhzoviBVcfGYlIZIhlSuhQ5bE_LcnhZ9SvnLQkh2g_M'
const AUTH = 'EAY5CR185BofDMFkvMZw4Q'
const keyBytes = (key: string) => Uint8Array.from(Buffer.from(key, 'base64url')).buffer

let endpoints = 0
function pushManager() {
  let current: ReturnType<typeof subscription> | null = null
  function subscription(key: ArrayBuffer) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${++endpoints}`
    const s = {
      endpoint,
      options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } }),
      unsubscribe: vi.fn(async () => {
        if (current === s) current = null
        return true
      }),
    }
    return s
  }
  return {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
      current = subscription(Uint8Array.from(options.applicationServerKey).buffer)
      return current
    }),
    current: () => current,
  }
}
function browser() {
  const registrations = new Map<string, ReturnType<typeof registration>>()
  function registration(scope: string) {
    const r = {
      scope: `${ORIGIN}${scope}`,
      active: {},
      pushManager: pushManager(),
      unregister: vi.fn(async () => registrations.delete(scope)),
    }
    return r
  }
  registrations.set('/', registration('/'))
  const workers = {
    register: vi.fn(async (_script: string, options: { scope: string }) => {
      if (!registrations.has(options.scope))
        registrations.set(options.scope, registration(options.scope))
      return registrations.get(options.scope)!
    }),
    getRegistrations: vi.fn(async () => [...registrations.values()]),
  }
  let permission: ReturnType<PushPorts['permission']> = 'granted'
  const watchers = new Set<() => void>()
  return {
    registrations,
    workers,
    watchers,
    ports: {
      permission: () => permission,
      workers: () => workers as never,
      watchPermission: (changed) => {
        watchers.add(changed)
        return () => watchers.delete(changed)
      },
    } satisfies PushPorts,
    setPermission: (next: typeof permission) => {
      permission = next
    },
  }
}
type View = { state: string; capabilities: string[]; webPushKey?: string }
function connection(view: Partial<View> = {}) {
  let generation = 1
  const c = {
    view: { state: 'ready', capabilities: ['sessions.read'], webPushKey: KEY, ...view } as View,
    snapshot: () => c.view,
    incarnation: () => ({ generation }),
    call: vi.fn(async (_method: string, _params?: unknown) => ({ ok: true, data: null })),
    reconnect: () => generation++,
  }
  return c
}

function setup() {
  const b = browser()
  const connections = new Map<string, ReturnType<typeof connection>>([
    [MAC, connection()],
    [OLD, connection({ webPushKey: undefined })],
  ])
  let session: { clientId: string } | null = { clientId: CLIENT }
  let directoryReady = true
  const changed = vi.fn()
  const push = createBrowserPush({
    hosts: {
      connection: (id) => connections.get(id) as never,
      snapshot: () =>
        Object.fromEntries([...connections].map(([id, c]) => [id, { ...c.view }])) as never,
      directoryReady: () => directoryReady,
    },
    session: () => session,
    changed,
    ports: b.ports,
  })
  push.start()
  const sync = async () => {
    push.sync()
    await vi.advanceTimersByTimeAsync(500)
  }
  return {
    ...b,
    push,
    connections,
    changed,
    sync,
    scope: (client: string, host: string) => b.registrations.get(`/push/${client}/${host}/`),
    setSession: (next: typeof session) => {
      session = next
    },
    setDirectoryReady: (next: boolean) => {
      directoryReady = next
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('browser Web Push registrations', () => {
  it("registers each Host that announces Web Push at its own scope, with that Host's key", async () => {
    const t = setup()
    await t.sync()
    expect(t.workers.register).toHaveBeenCalledTimes(1)
    expect(t.workers.register).toHaveBeenCalledWith('/sw.js', {
      type: 'module',
      scope: `/push/${CLIENT}/${MAC}/`,
    })
    const manager = t.scope(CLIENT, MAC)!.pushManager
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(keyBytes(KEY)),
    })
    const mac = t.connections.get(MAC)!
    expect(mac.call).toHaveBeenCalledWith('notifications.subscribe', {
      endpoint: manager.current()!.endpoint,
      keys: { p256dh: P256DH, auth: AUTH },
    })
    expect(t.connections.get(OLD)!.call).not.toHaveBeenCalled()
    expect(t.scope(CLIENT, OLD)).toBeUndefined()
    const view = t.push.project({ [MAC]: { state: 'ready' }, [OLD]: { state: 'ready' } } as never)
    expect(view[MAC]).toMatchObject({ pushRegistration: 'registered' })
    expect(view[OLD]).not.toHaveProperty('pushRegistration')
    expect(t.changed).toHaveBeenCalled()
  })
  it('does nothing again until something changes, and registers again on a reconnect', async () => {
    const t = setup()
    await t.sync()
    await t.sync()
    const mac = t.connections.get(MAC)!
    expect(mac.call).toHaveBeenCalledTimes(1)
    mac.reconnect()
    mac.view = { ...mac.view, state: 'reconnecting' }
    await t.sync()
    mac.view = { ...mac.view, state: 'ready' }
    await t.sync()
    expect(mac.call).toHaveBeenCalledTimes(2)
    expect(t.scope(CLIENT, MAC)!.pushManager.subscribe).toHaveBeenCalledTimes(1)
  })
  it('subscribes again when the Host key changes', async () => {
    const t = setup()
    await t.sync()
    const manager = t.scope(CLIENT, MAC)!.pushManager
    const first = manager.current()!
    const mac = t.connections.get(MAC)!
    mac.view = { ...mac.view, webPushKey: OTHER_KEY }
    await t.sync()
    expect(first.unsubscribe).toHaveBeenCalled()
    expect(manager.subscribe).toHaveBeenLastCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(keyBytes(OTHER_KEY)),
    })
  })
  it('tells the Host, unsubscribes and unregisters when notifications are turned off', async () => {
    const t = setup()
    await t.sync()
    const registration = t.scope(CLIENT, MAC)!
    const subscription = registration.pushManager.current()!
    t.setPermission('denied')
    await t.sync()
    expect(t.connections.get(MAC)!.call).toHaveBeenLastCalledWith('notifications.unsubscribe', {
      endpoint: subscription.endpoint,
    })
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(registration.unregister).toHaveBeenCalled()
    expect(t.push.project({ [MAC]: {} } as never)[MAC]).not.toHaveProperty('pushRegistration')
    t.setPermission('granted')
    await t.sync()
    expect(t.scope(CLIENT, MAC)).toBeDefined()
  })
  it('follows the permission when the device reports a change, without a Host event', async () => {
    const t = setup()
    t.setPermission('default')
    await t.sync()
    expect(t.workers.register).not.toHaveBeenCalled()
    t.setPermission('granted')
    for (const changed of t.watchers) changed()
    await vi.advanceTimersByTimeAsync(500)
    expect(t.scope(CLIENT, MAC)).toBeDefined()
    t.setPermission('denied')
    for (const changed of t.watchers) changed()
    await vi.advanceTimersByTimeAsync(500)
    expect(t.scope(CLIENT, MAC)).toBeUndefined()
    t.push.dispose()
    expect(t.watchers.size).toBe(0)
  })
  it('removes a scope that finished installing after a sign-out', async () => {
    const t = setup()
    let finish!: () => void
    const register = t.workers.register.getMockImplementation()!
    t.workers.register.mockImplementationOnce(async (script, options) => {
      await new Promise<void>((resolve) => (finish = resolve))
      return register(script, options)
    })
    t.push.sync()
    await vi.advanceTimersByTimeAsync(500)
    t.setSession(null)
    t.push.accountChanged(null)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect([...t.registrations.keys()]).toStrictEqual(['/'])
    expect(t.connections.get(MAC)!.call).not.toHaveBeenCalledWith(
      'notifications.subscribe',
      expect.anything(),
    )
  })
  it('removes every push scope on a definite sign-out, and none when an account loads', async () => {
    const t = setup()
    await t.sync()
    t.push.accountChanged(CLIENT)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.scope(CLIENT, MAC)).toBeDefined()
    const subscription = t.scope(CLIENT, MAC)!.pushManager.current()!
    t.push.accountChanged(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect([...t.registrations.keys()]).toStrictEqual(['/'])
  })
  it("removes another sign-in's scopes and registers this one's, and leaves the app scope", async () => {
    const t = setup()
    await t.sync()
    const old = t.scope(CLIENT, MAC)!
    t.setSession({ clientId: NEW_CLIENT })
    t.push.accountChanged('owner')
    await t.sync()
    expect(old.unregister).toHaveBeenCalled()
    expect(old.pushManager.current()).toBeNull()
    expect([...t.registrations.keys()]).toStrictEqual(['/', `/push/${NEW_CLIENT}/${MAC}/`])
  })
  it('touches nothing before the account is known, without the app worker, or offline', async () => {
    const t = setup()
    t.setSession(null)
    await t.sync()
    expect(t.workers.getRegistrations).not.toHaveBeenCalled()
    t.setSession({ clientId: CLIENT })
    t.registrations.delete('/')
    await t.sync()
    expect(t.workers.register).not.toHaveBeenCalled()
  })
  it('removes a Host that left the directory, but not while the directory is unknown', async () => {
    const t = setup()
    await t.sync()
    const mac = t.scope(CLIENT, MAC)!
    t.connections.delete(MAC)
    t.setDirectoryReady(false)
    await t.sync()
    expect(mac.unregister).not.toHaveBeenCalled()
    t.setDirectoryReady(true)
    await t.sync()
    expect(mac.unregister).toHaveBeenCalled()
  })
  it('removes a scope whose Host stopped announcing Web Push, and unknown push scopes', async () => {
    const t = setup()
    await t.sync()
    const stray = { ...t.scope(CLIENT, MAC)!, scope: `${ORIGIN}/push/older-layout/` }
    stray.unregister = vi.fn(async () => true)
    t.registrations.set('/push/stray/', stray)
    const mac = t.connections.get(MAC)!
    mac.view = { ...mac.view, webPushKey: undefined }
    await t.sync()
    expect(t.scope(CLIENT, MAC)).toBeUndefined()
    expect(stray.unregister).toHaveBeenCalled()
  })
  it('reports a failed registration and tries again later', async () => {
    const t = setup()
    const mac = t.connections.get(MAC)!
    mac.call.mockResolvedValueOnce({ ok: false, data: null } as never)
    await t.sync()
    expect(t.push.project({ [MAC]: {} } as never)[MAC]).toMatchObject({
      pushRegistration: 'failed',
    })
    await t.sync()
    expect(mac.call).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await t.sync()
    expect(mac.call).toHaveBeenCalledTimes(2)
    expect(t.push.project({ [MAC]: {} } as never)[MAC]).toMatchObject({
      pushRegistration: 'registered',
    })
  })
  it('fails a subscription the browser never settles, and still removes on permission loss', async () => {
    const t = setup()
    const manager = () => t.scope(CLIENT, MAC)!.pushManager
    const register = t.workers.register.getMockImplementation()!
    t.workers.register.mockImplementationOnce(async (script, options) => {
      const registration = await register(script, options)
      registration.pushManager.subscribe.mockImplementationOnce(() => new Promise(() => {}))
      return registration
    })
    t.push.sync()
    await vi.advanceTimersByTimeAsync(500)
    expect(manager().subscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.push.project({ [MAC]: {} } as never)[MAC]).toMatchObject({
      pushRegistration: 'failed',
    })
    t.setPermission('denied')
    await t.sync()
    expect(t.scope(CLIENT, MAC)).toBeUndefined()
  })
  it('keeps registrations when the page closes', async () => {
    const t = setup()
    await t.sync()
    t.push.dispose()
    await t.sync()
    expect(t.scope(CLIENT, MAC)!.unregister).not.toHaveBeenCalled()
  })
})

describe('browser Web Push through the adapter', () => {
  /** A device that registered with the Mac on an earlier visit. */
  async function configured() {
    const b = browser()
    const registration = await b.workers.register('/sw.js', { scope: `/push/${CLIENT}/${MAC}/` })
    const subscription = await registration.pushManager.subscribe({
      applicationServerKey: new Uint8Array(keyBytes(KEY)),
    })
    vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), b.workers) })
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('PushManager', class {})
    return { registration, subscription }
  }
  const adapter = (fetch: typeof globalThis.fetch) =>
    createBrowserApi({
      fetch,
      storage: null,
      invalidation: null,
      lifecycle: { subscribe: () => () => {} },
    })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('keeps them when startup is offline and the page disposes the adapter', async () => {
    const { registration, subscription } = await configured()
    const bridge = adapter(async () => {
      throw new TypeError('Failed to fetch')
    })
    await bridge.start()
    await vi.advanceTimersByTimeAsync(1_000)
    bridge.dispose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(registration.unregister).not.toHaveBeenCalled()
  })
  it('removes them when Control confirms the browser is signed out', async () => {
    const { registration, subscription } = await configured()
    const bridge = adapter(async () => new Response('', { status: 401 }))
    try {
      await bridge.start()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(subscription.unsubscribe).toHaveBeenCalled()
      expect(registration.unregister).toHaveBeenCalled()
    } finally {
      bridge.dispose()
    }
  })
})
