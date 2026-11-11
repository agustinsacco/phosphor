// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { NotificationDrawer } from './NotificationDrawer'
import { NotificationsButton } from './NotificationsButton'

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
})

const rows = () => Array.from(container.querySelectorAll('[data-testid="notification-row"]'))

it('badges the bell with new notices and takes on-screen cards into the drawer', () => {
  const onOpen = vi.fn()
  act(() => {
    useExtensionUiStore.getState().notify({ message: 'Finished.', sessionId: 's1', onOpen })
    root.render(<NotificationsButton />)
  })
  const bell = container.querySelector<HTMLButtonElement>('[data-testid="notifications-button"]')!
  expect(bell.getAttribute('aria-label')).toBe('Notifications, 1 new')
  expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  act(() => bell.click())
  expect(useNotificationsStore.getState().open).toBe(true)
  expect(useExtensionUiStore.getState().toasts.every((toast) => toast.leaving)).toBe(true)
})

it('shows new and seen notices apart, opens one, and removes one', () => {
  const onOpen = vi.fn()
  act(() => {
    const { notify, pushToast } = useExtensionUiStore.getState()
    notify({ message: 'Finished.', title: 'CI lane', kind: 'success', sessionId: 's1', onOpen })
    pushToast('Disk full', 'error')
    useNotificationsStore.getState().markSeen([useNotificationsStore.getState().items[0]!.id])
    root.render(<NotificationDrawer />)
  })
  expect(container.textContent).toContain('1 new')
  expect(rows().map((row) => row.hasAttribute('data-seen'))).toEqual([false, true])
  expect(container.textContent).toMatch(/New.*CI lane.*Earlier.*Disk full/)

  act(() => rows()[0]!.querySelector('button')!.click())
  expect(onOpen).toHaveBeenCalledOnce()
  // The open one is seen now; it is still in the list.
  expect(rows().map((row) => row.hasAttribute('data-seen'))).toEqual([true, true])

  act(() =>
    rows()[0]!.querySelector<HTMLButtonElement>('[aria-label="Remove notification"]')!.click(),
  )
  expect(rows()).toHaveLength(1)
})

it('shows a receipt row with its facts, and opens it in place to where it ran and its actions', () => {
  const onOpen = vi.fn()
  act(() => {
    useExtensionUiStore.getState().notify({
      message: 'Stopped: rate limit',
      title: 'Memory lane',
      kind: 'error',
      sessionId: 's1',
      onOpen,
      receipt: {
        machine: 'This Mac',
        at: new Date().toISOString(),
        facts: {
          title: 'Memory lane',
          repository: 'phosphor',
          branch: 'agustin/memory',
          settledAt: null,
          durationMs: 3000,
          files: 2,
          added: 4,
          removed: 1,
          tests: 'failed',
          artifacts: 0,
          excerpt: 'rate limit',
          outcome: 'error',
        },
      },
    })
    root.render(<NotificationDrawer />)
  })
  const toggle = rows()[0]!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(container.textContent).toContain('2 files')
  expect(container.textContent).toContain('tests failed')
  expect(container.textContent).not.toContain('⎇ agustin/memory')
  expect(container.textContent).not.toContain('View changes')

  act(() => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(onOpen).not.toHaveBeenCalled()
  for (const text of ['This Mac', 'phosphor · ⎇ agustin/memory', 'View changes', 'Retry'])
    expect(container.textContent).toContain(text)
  expect(rows()[0]!.hasAttribute('data-seen')).toBe(false)

  act(() =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open lane')!.click(),
  )
  expect(onOpen).toHaveBeenCalledOnce()
  expect(rows()[0]!.hasAttribute('data-seen')).toBe(true)
})
