// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { AccountAvatar, AccountFooter, avatarInitials } from './AccountFooter'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useMachinesStore } from '@/stores/machines'

let root: Root
let container: HTMLDivElement
let account: AccountView
let push: (view: AccountView) => void
const user = { login: 'octo', name: 'Octo Cat', email: 'octo@example.com' }
const invoke = vi.fn(async (channel: string) => (channel === 'account:get' ? account : undefined))
beforeEach(() => {
  account = { account: { status: 'signed-out' } }
  invoke.mockClear()
  vi.stubGlobal('phosphor', {
    platform: 'darwin',
    invoke,
    onAccountChanged: (listener: typeof push) => {
      push = listener
      return () => undefined
    },
  })
  useSettingsUiStore.setState({ open: false })
  useMachinesStore.setState({ statuses: { one: 'up', two: 'down' }, view: { kind: 'list' } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async (): Promise<void> => {
  await act(async () => root.render(<AccountFooter />))
}
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll('button')).find(
    (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
  )
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
const click = async (label: string): Promise<void> => {
  await act(async () => button(label).click())
}
const key = (value: string): void => {
  act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true }),
    ),
  )
}

it('offers optional GitHub sign-in and direct settings while signed out', async () => {
  await render()
  await click('Sign in')
  expect(container.textContent).toContain('Sign-in is optional')
  expect(document.activeElement).toBe(button('Sign in with GitHub'))
  await click('Sign in with GitHub')
  expect(invoke).toHaveBeenCalledWith('account:signIn')
  await click('Settings')
  expect(useSettingsUiStore.getState().open).toBe(true)
})
it('shows the signed-in header, online count, machine navigation and sign-out', async () => {
  account = { account: { status: 'signed-in', user, remembered: true } }
  await render()
  await click('Your account')
  expect(container.textContent).toContain('Octo Cat')
  expect(container.textContent).toContain('@octo')
  expect(container.textContent).toContain('octo@example.com')
  expect(container.textContent).toContain('1 online')
  const machines = Array.from(document.querySelectorAll('button')).find((entry) =>
    entry.textContent?.startsWith('Machines'),
  )
  await act(async () => machines?.click())
  expect(useMachinesStore.getState().view).toEqual({ kind: 'list' })
  await click('Your account')
  await click('Sign out')
  expect(invoke).toHaveBeenCalledWith('account:signOut')
  expect(document.querySelector('[data-popup-menu]')).toBeNull()
})
it('supports keyboard navigation, Escape and outside dismissal with focus return', async () => {
  await render()
  button('Sign in').focus()
  // Native Enter/Space click activation is preserved by using a real button.
  await click('Sign in')
  key('ArrowDown')
  expect(document.activeElement?.textContent).toContain('Settings')
  key('Home')
  expect(document.activeElement).toBe(button('Sign in with GitHub'))
  key('End')
  expect(document.activeElement?.textContent).toContain('Settings')
  key('ArrowUp')
  expect(document.activeElement).toBe(button('Sign in with GitHub'))
  key('Escape')
  expect(document.querySelector('[data-popup-menu]')).toBeNull()
  expect(document.activeElement).toBe(button('Sign in'))
  await click('Sign in')
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(document.querySelector('[data-popup-menu]')).toBeNull()
  expect(document.activeElement).toBe(button('Sign in'))
})
it('shows signing-in progress and Cancel, then accepts the pushed state', async () => {
  account = { account: { status: 'signing-in' } }
  await render()
  expect(container.textContent).toContain('Finish in your browser')
  expect(document.querySelector('[data-popup-menu]')).toBeNull()
  await click('Cancel')
  expect(invoke).toHaveBeenCalledWith('account:cancelSignIn')
  act(() => push({ account: { status: 'signed-out', error: 'Sign-in timed out.' } }))
  expect(button('Sign in')).toBeDefined()
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Sign-in timed out')
})
it('uses deterministic initials and colour on missing or failed images, never a remote renderer URL', async () => {
  expect(avatarInitials(user)).toBe('OC')
  expect(avatarInitials({ login: 'octo', name: null, email: null })).toBe('O')
  expect(avatarInitials()).toBe('?')
  await act(async () =>
    root.render(
      <AccountAvatar
        user={{ ...user, avatarDataUrl: 'https://avatars.githubusercontent.com/u/1' }}
      />,
    ),
  )
  expect(container.querySelector('img')).toBeNull()
  const colour = container.firstElementChild?.className
  await act(async () =>
    root.render(<AccountAvatar user={{ ...user, avatarDataUrl: 'data:image/png;base64,AQID' }} />),
  )
  expect(container.querySelector('img')?.src).toBe('data:image/png;base64,AQID')
  act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))
  expect(container.textContent).toBe('OC')
  expect(container.firstElementChild?.className).toBe(colour)
})
