// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createBrowserNotifications,
  attachNotificationClicks,
  navigateNotification,
} from './notifications'
import { createBrowserApi } from './index'

const notice = { title: 'bee1 · Lane', body: 'Done', route: { hostId: 'host', laneId: 'lane' } }
afterEach(() => vi.unstubAllGlobals())
function fixture(hidden = true, permission: NotificationPermission | 'unavailable' = 'granted') {
  const showNotification = vi.fn(async () => {})
  const postMessage = vi.fn()
  const registration = vi.fn(
    async () =>
      ({ showNotification, active: { postMessage } }) as unknown as ServiceWorkerRegistration,
  )
  const ports = { hidden: () => hidden, permission: () => permission, registration }
  return {
    ...createBrowserNotifications(ports),
    ports,
    showNotification,
    postMessage,
    registration,
  }
}
it.each(['default', 'denied', 'unavailable'] as const)(
  'never prompts or delivers with permission %s',
  async (permission) => {
    const t = fixture(true, permission)
    expect(await t.notify(notice)).toBe(false)
    await t.attention(notice, () => true)
    expect(t.registration).not.toHaveBeenCalled()
  },
)
it('delivers only while hidden, via the worker, and returns false without awaiting a click', async () => {
  const t = fixture(false)
  expect(await t.notify(notice)).toBe(false)
  expect(t.registration).not.toHaveBeenCalled()
  t.ports.hidden = () => true
  expect(await t.notify(notice)).toBe(false)
  expect(t.showNotification).toHaveBeenCalledWith(
    notice.title,
    expect.objectContaining({
      body: 'Done',
      tag: 'phosphor:lane:host:lane',
      data: { type: 'phosphor-notification', route: notice.route },
    }),
  )
})
it('rechecks visibility and permission after the worker lookup', async () => {
  for (const field of ['hidden', 'permission'] as const) {
    const t = fixture()
    t.registration.mockImplementation(async () => {
      if (field === 'hidden') t.ports.hidden = () => false
      else t.ports.permission = () => 'denied'
      return { showNotification: t.showNotification } as unknown as ServiceWorkerRegistration
    })
    expect(await t.notify(notice)).toBe(false)
    expect(t.showNotification).not.toHaveBeenCalled()
  }
})
it('handles missing worker, lookup failure and denied delivery without unhandled promises', async () => {
  const notify = createBrowserNotifications({
    hidden: () => true,
    permission: () => 'granted',
    registration: async () => undefined,
  }).notify
  expect(await notify(notice)).toBe(false)
  const t = fixture()
  t.registration.mockRejectedValueOnce(new Error('No worker'))
  expect(await t.notify(notice)).toBe(false)
  t.showNotification.mockRejectedValueOnce(new Error('Permission changed'))
  expect(await t.notify(notice)).toBe(false)
})
it('sends attention to the worker even while visible elsewhere, but fences account/disposal changes', async () => {
  const t = fixture(false)
  await t.attention(notice, () => false)
  expect(t.postMessage).not.toHaveBeenCalled()
  await t.attention(notice, () => true)
  expect(t.postMessage).toHaveBeenCalledWith({ type: 'phosphor-attention', notice })
})
it('implements the public browser app:notify classification without a network request', async () => {
  const t = fixture()
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', {
    serviceWorker: Object.assign(new EventTarget(), { getRegistration: t.registration }),
  })
  vi.stubGlobal('document', { visibilityState: 'hidden' })
  const fetch = vi.fn<typeof globalThis.fetch>()
  const bridge = createBrowserApi({
    fetch,
    storage: null,
    lifecycle: { subscribe: () => () => {} },
    invalidation: null,
  })
  try {
    expect(await bridge.api.invoke('app:notify', notice)).toBe(false)
    expect(t.showNotification).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    bridge.dispose()
  }
})
it('accepts only same-origin worker click messages, routes in-app and detaches on disposal', () => {
  const workers = new EventTarget()
  vi.stubGlobal('navigator', { serviceWorker: workers })
  const navigate = vi.fn()
  const off = attachNotificationClicks(navigate)
  const emit = (origin: string, data: unknown) =>
    workers.dispatchEvent(new MessageEvent('message', { origin, data }))
  emit('https://other.invalid', { type: 'phosphor-notification', route: notice.route })
  emit(location.origin, { type: 'other' })
  expect(navigate).not.toHaveBeenCalled()
  emit(location.origin, { type: 'phosphor-notification', route: notice.route })
  expect(navigate).toHaveBeenLastCalledWith('/lanes/host/lane/chat')
  off()
  emit(location.origin, { type: 'phosphor-notification', route: notice.route })
  expect(navigate).toHaveBeenCalledOnce()
})
it('notifies the history router without a reload', () => {
  const pop = vi.fn()
  window.addEventListener('popstate', pop)
  navigateNotification('/lanes/host/lane/chat')
  expect(location.pathname).toBe('/lanes/host/lane/chat')
  expect(pop).toHaveBeenCalledOnce()
  window.removeEventListener('popstate', pop)
})
