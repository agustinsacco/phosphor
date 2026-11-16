// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { NotificationsButton } from '@/features/notifications/NotificationsButton'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { BrowserNotifications } from './BrowserNotifications'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent === name,
  )!
function mount(compact: boolean) {
  act(() =>
    root.render(
      <PlatformProvider value={compact ? COMPACT_PLATFORM : WIDE_BROWSER_PLATFORM}>
        <NotificationsButton />
        <BrowserNotifications />
      </PlatformProvider>,
    ),
  )
  act(() =>
    container.querySelector<HTMLButtonElement>('[data-testid="notifications-button"]')!.click(),
  )
}
it.each([true, false])(
  'keeps warnings/errors and openable notices in the browser; compact=%s',
  async (compact) => {
    const onOpen = vi.fn()
    const { notify, pushToast } = useExtensionUiStore.getState()
    pushToast('Copied')
    pushToast('Connection lost', 'warning')
    pushToast('Disk full', 'error')
    notify({ message: 'Open machine', onOpen })
    mount(compact)
    expect(document.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(3)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(compact ? 1 : 0)
    await act(async () => button('Open machine').click())
    expect(onOpen).toHaveBeenCalledOnce()
    expect(!!document.querySelector('[data-testid="notification-drawer"]')).toBe(!compact)
  },
)
it('expands Host receipts in place, preserves New, then closes the sheet when opening the lane', async () => {
  const onOpen = vi.fn()
  useExtensionUiStore.getState().notify({
    message: 'Done',
    title: 'bee1 · Lane',
    onOpen,
    receipt: { machine: 'bee1', machineId: 'host', laneId: 'lane', at: new Date().toISOString() },
  })
  mount(true)
  const row = document.querySelector<HTMLButtonElement>('[aria-expanded]')!
  act(() => row.click())
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(useNotificationsStore.getState().items[0]!.seenAt).toBeUndefined()
  await act(async () => button('Open lane').click())
  expect(onOpen).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('marks all seen, clears Earlier, closes with Escape and returns focus to the bell', () => {
  useExtensionUiStore.getState().pushToast('Warning', 'warning')
  act(() =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NotificationsButton />
        <BrowserNotifications />
      </PlatformProvider>,
    ),
  )
  const bell = container.querySelector<HTMLButtonElement>('[data-testid="notifications-button"]')!
  bell.focus()
  act(() => bell.click())
  act(() => button('Mark all seen').click())
  expect(document.body.textContent).toContain('Earlier')
  act(() => button('Clear').click())
  expect(document.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(0)
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(useNotificationsStore.getState().open).toBe(false)
  expect(document.activeElement).toBe(bell)
})
it('offers permission quietly and requests only after a gesture; failure can be retried', async () => {
  const requestPermission = vi
    .fn()
    .mockRejectedValueOnce(new Error('Failed'))
    .mockResolvedValueOnce('granted')
  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  vi.stubGlobal('navigator', { serviceWorker: {} })
  mount(true)
  expect(document.body.textContent).toContain('Get notified when a lane needs you')
  expect(requestPermission).not.toHaveBeenCalled()
  await act(async () => button('Turn on').click())
  expect(document.body.textContent).toContain('Could not request notifications. Try again.')
  await act(async () => button('Turn on').click())
  expect(requestPermission).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).not.toContain('Get notified when a lane needs you')
})

it.each([true, false])(
  'opening one Host receipt preserves other new notices; compact=%s',
  async (compact) => {
    const onOpen = vi.fn()
    for (const laneId of ['first', 'second'])
      useExtensionUiStore.getState().notify({
        message: 'Done',
        title: `bee1 · ${laneId}`,
        onOpen,
        receipt: { machine: 'bee1', machineId: 'host', laneId, at: new Date().toISOString() },
      })
    mount(compact)
    act(() => button('bee1 · first').click())
    await act(async () => button('Open lane').click())
    expect(onOpen).toHaveBeenCalledOnce()
    const items = useNotificationsStore.getState().items
    expect(items.find((item) => item.receipt?.laneId === 'first')?.seenAt).toBeDefined()
    expect(items.find((item) => item.receipt?.laneId === 'second')?.seenAt).toBeUndefined()
    expect(useNotificationsStore.getState().open).toBe(!compact)
    expect(
      container.querySelector('[data-testid="notifications-button"]')?.getAttribute('aria-label'),
    ).toBe('Notifications, 1 new')
    if (compact) act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(
      document.querySelectorAll('[data-testid="notification-row"]:not([data-seen])'),
    ).toHaveLength(1)
  },
)
