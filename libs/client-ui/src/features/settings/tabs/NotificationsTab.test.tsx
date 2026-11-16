// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@phosphor/shared/control-api'
import type { HostsSnapshot } from '@phosphor/shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { NotificationsTab } from './NotificationsTab'
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
  [...container.querySelectorAll('button')].find((b) => b.textContent === name)!
it.each([
  ['default', 'Off'],
  ['denied', 'Blocked'],
  ['granted', 'On'],
] as const)('shows %s without prompting and explains blocking', (permission, label) => {
  const requestPermission = vi.fn()
  vi.stubGlobal('Notification', { permission, requestPermission })
  vi.stubGlobal('navigator', { serviceWorker: {} })
  act(() => root.render(<NotificationsTab />))
  expect(container.textContent).toContain(label)
  expect(requestPermission).not.toHaveBeenCalled()
  expect(button('Turn on notifications').disabled).toBe(permission !== 'default')
  expect(button('Send a test notification').disabled).toBe(permission !== 'granted')
  expect(container.textContent?.includes('browser’s site settings')).toBe(permission === 'denied')
})
it('uses showNotification for a visible-page test, reports failure and recovers on retry', async () => {
  const showNotification = vi
    .fn()
    .mockRejectedValueOnce(new Error('Failed'))
    .mockResolvedValueOnce(undefined)
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: async () => ({ showNotification }) },
  })
  act(() => root.render(<NotificationsTab />))
  await act(async () => button('Send a test notification').click())
  expect(container.textContent).toContain('Could not send a test notification.')
  await act(async () => button('Send a test notification').click())
  expect(container.textContent).toContain('Test notification sent.')
  expect(showNotification).toHaveBeenLastCalledWith(
    'Phosphor',
    expect.objectContaining({ body: 'Notifications are on.', tag: 'phosphor:test' }),
  )
})
it('lists which machines notify this device while closed, only once notifications are on', () => {
  vi.stubGlobal('navigator', { serviceWorker: {} })
  const machine = (id: string, label: string) => ({ id, label }) as MachineView
  useMachinesStore.setState({
    machines: [
      machine('mac', 'Studio'),
      machine('old', 'Old box'),
      machine('down', 'Laptop'),
      machine('fail', 'Server'),
      machine('new', 'Mini'),
      machine('gone', 'Not in snapshot'),
    ],
  })
  const ready = { state: 'ready', capabilities: ['sessions.read'] } as const
  useRemoteLanesStore.setState({
    hosts: {
      mac: { ...ready, webPushKey: 'k', pushRegistration: 'registered' },
      old: ready,
      down: { state: 'down' },
      fail: { ...ready, webPushKey: 'k', pushRegistration: 'failed' },
      new: { ...ready, webPushKey: 'k' },
    } as unknown as HostsSnapshot,
  })
  vi.stubGlobal('Notification', { permission: 'default' })
  act(() => root.render(<NotificationsTab />))
  expect(container.textContent).not.toContain('When Phosphor is closed')
  act(() => root.unmount())
  root = createRoot(container)
  vi.stubGlobal('Notification', { permission: 'granted' })
  act(() => root.render(<NotificationsTab />))
  const rows = [...container.querySelectorAll('li')].map((li) =>
    [...li.children].map((c) => c.textContent),
  )
  expect(rows).toStrictEqual([
    ['Studio', 'On'],
    ['Old box', 'Not supported'],
    ['Laptop', 'Down'],
    ['Server', 'Could not register'],
    ['Mini', 'Setting up'],
  ])
})
