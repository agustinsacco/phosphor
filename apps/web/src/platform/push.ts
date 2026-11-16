import { decodeBase64url } from '@phosphor/shared/host-grant'
import type { HostsSnapshot } from '@phosphor/shared/ipc'
import { hostWebPushKey, registerWebPush, unregisterWebPush } from '@phosphor/host-client/web-push'
import { isPushScope, parsePushScope, pushScopePath } from '../push-scope'
import type { BrowserHosts } from './hosts'

type Workers = Pick<ServiceWorkerContainer, 'register' | 'getRegistrations'>
export interface PushPorts {
  permission(): NotificationPermission | 'unavailable'
  workers(): Workers | undefined
}
const browserPorts: PushPorts = {
  permission: () =>
    typeof Notification === 'undefined' || typeof PushManager === 'undefined'
      ? 'unavailable'
      : Notification.permission,
  workers: () => globalThis.navigator?.serviceWorker,
}
type PushHosts = Pick<BrowserHosts, 'connection' | 'snapshot' | 'directoryReady'>
type Connection = NonNullable<ReturnType<BrowserHosts['connection']>>
type Scoped = { registration: ServiceWorkerRegistration; clientId: string; hostId: string }

/** Changes arrive with every lane event; the registrations are reconciled at most this often. */
const SYNC_MS = 500
/** A failed registration is tried again after this long, or when the Host reconnects. */
const RETRY_MS = 30_000
const ACTIVATION_MS = 30_000

async function activated(registration: ServiceWorkerRegistration) {
  const worker = registration.installing ?? registration.waiting
  if (registration.active || !worker) return registration
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not activate')), ACTIVATION_MS)
    const check = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return
      clearTimeout(timer)
      worker.removeEventListener('statechange', check)
      if (worker.state === 'activated') resolve()
      else reject(new Error('worker redundant'))
    }
    worker.addEventListener('statechange', check)
    check()
  })
  return registration
}

/** The scope's subscription for this Host's key; one made with another key is replaced. */
async function subscribed(manager: PushManager, key: string): Promise<PushSubscription> {
  const bytes = new Uint8Array(decodeBase64url(key) ?? [])
  const existing = await manager.getSubscription()
  const current = existing?.options.applicationServerKey
  if (existing && current && bytes.every((b, i) => new Uint8Array(current)[i] === b))
    return existing
  await existing?.unsubscribe()
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
}

/** The subscription as the Host's contract names it, without the browser's extra fields. */
function wire(subscription: PushSubscription) {
  const { endpoint, keys } = subscription.toJSON()
  return { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } }
}

interface PushOptions {
  hosts: PushHosts
  session(): { clientId: string } | null
  changed(): void
  ports?: PushPorts
}
interface PushState {
  options: PushOptions
  ports: PushPorts
  statuses: Map<string, 'registered' | 'failed'>
  confirmed: Map<string, { connection: Connection; generation: number; key: string }>
  stopped: boolean
}

function setStatus(state: PushState, hostId: string, status?: 'registered' | 'failed') {
  if (state.statuses.get(hostId) === status) return
  if (status) state.statuses.set(hostId, status)
  else state.statuses.delete(hostId)
  state.options.changed()
}

/** Tell the Host when it is reachable, unsubscribe, then drop the registration. */
async function removeScope(state: PushState, scoped: Scoped) {
  try {
    const subscription = await scoped.registration.pushManager.getSubscription()
    const connection = state.options.hosts.connection(scoped.hostId)
    if (subscription && connection)
      await unregisterWebPush(connection, subscription.endpoint).catch(() => false)
    await subscription?.unsubscribe()
  } catch {
    // Unregistering the scope below also drops its subscription in this browser.
  }
  await scoped.registration.unregister().catch(() => false)
  state.confirmed.delete(scoped.hostId)
  setStatus(state, scoped.hostId)
}

/** False when this Host should have been registered and was not. */
async function registerScope(
  state: PushState,
  workers: Workers,
  scope: { clientId: string; hostId: string },
  c: Connection,
) {
  const key = hostWebPushKey(c)
  const path = pushScopePath(scope.clientId, scope.hostId)
  const generation = c.incarnation().generation
  const done = state.confirmed.get(scope.hostId)
  if (
    !key ||
    !path ||
    (done?.connection === c && done.generation === generation && done.key === key)
  )
    return true
  try {
    const registration = await activated(
      await workers.register('/sw.js', { type: 'module', scope: path }),
    )
    const ok = await registerWebPush(c, wire(await subscribed(registration.pushManager, key)))
    if (ok) state.confirmed.set(scope.hostId, { connection: c, generation, key })
    setStatus(state, scope.hostId, ok ? 'registered' : 'failed')
    return ok
  } catch {
    setStatus(state, scope.hostId, 'failed')
    return false
  }
}

/** Remove stale scopes, then register every ready Host that announces Web Push. */
async function reconcileScopes(
  state: PushState,
  workers: Workers,
  clientId: string,
  view: HostsSnapshot,
) {
  const granted = state.ports.permission() === 'granted'
  const directory = state.options.hosts.directoryReady()
  const registrations = await workers.getRegistrations()
  // Push scopes are registrations of the app's own worker; without it (a dev server), none.
  if (!registrations.some((r) => new URL(r.scope).pathname === '/')) return true
  for (const registration of registrations) {
    const parsed = parsePushScope(registration.scope)
    const host = parsed && view[parsed.hostId]
    // A push scope this version cannot read is no Host's any more.
    if (!parsed && isPushScope(registration.scope))
      await registration.unregister().catch(() => false)
    else if (
      parsed &&
      (!granted ||
        parsed.clientId !== clientId ||
        (directory && !host) ||
        (host?.state === 'ready' && !host.webPushKey))
    )
      await removeScope(state, { registration, ...parsed })
  }
  if (!granted || state.stopped) return true
  let complete = true
  for (const hostId of Object.keys(view)) {
    const connection = state.options.hosts.connection(hostId)
    if (connection && !(await registerScope(state, workers, { clientId, hostId }, connection)))
      complete = false
  }
  return complete
}

/** Every push scope of this browser, after a definite sign-out. */
async function removeAll(state: PushState) {
  for (const registration of (await state.ports.workers()?.getRegistrations()) ?? []) {
    const parsed = parsePushScope(registration.scope)
    if (parsed) await removeScope(state, { registration, ...parsed })
  }
}

/**
 * This device's Web Push registrations, one per Host that announces it, while notifications
 * are allowed and the account is signed in. Closing the page keeps them; turning
 * notifications off, signing out, another account or a Host leaving the directory removes
 * them. The subscription is unsubscribed before its registration goes, so the push service
 * refuses the Host from then on even if the Host never hears of it.
 */
export function createBrowserPush(options: PushOptions) {
  const state: PushState = {
    options,
    ports: options.ports ?? browserPorts,
    statuses: new Map(),
    confirmed: new Map(),
    stopped: false,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false,
    again = false,
    last = '',
    retryAt = 0
  async function run() {
    const workers = state.ports.workers()
    const session = options.session()
    // Not signed in yet is not signed out: only a definite sign-out removes registrations.
    if (!workers || !session) return
    const view = options.hosts.snapshot()
    const signature = JSON.stringify([
      session.clientId,
      state.ports.permission(),
      options.hosts.directoryReady(),
      Object.entries(view).map(([id, h]) => [id, h.state, h.webPushKey, h.capabilities]),
    ])
    if (signature === last && Date.now() < retryAt) return
    const complete = await reconcileScopes(state, workers, session.clientId, view)
    last = signature
    retryAt = complete ? Infinity : Date.now() + RETRY_MS
  }
  async function drain() {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await run()
      } while (again && !state.stopped)
    } catch {
      last = ''
    } finally {
      running = false
    }
  }
  return {
    /** Host, account or permission state may have changed. */
    sync() {
      if (state.stopped || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void drain()
      }, SYNC_MS)
    },
    /** `null` is a definite sign-out: every push registration of this browser goes. */
    accountChanged(owner: string | null) {
      last = ''
      state.confirmed.clear()
      if (owner === null) void removeAll(state).catch(() => {})
    },
    /** The snapshot with this device's registration state for each Host. */
    project(view: HostsSnapshot): HostsSnapshot {
      return Object.fromEntries(
        Object.entries(view).map(([id, host]) => {
          const status = state.statuses.get(id)
          return [id, status ? { ...host, pushRegistration: status } : host]
        }),
      )
    },
    dispose() {
      state.stopped = true
      clearTimeout(timer)
    },
  }
}
export type BrowserPush = ReturnType<typeof createBrowserPush>
