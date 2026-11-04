// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { AccountAvatar, AccountFooter, avatarInitials } from './AccountFooter'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useMachinesStore } from '@/stores/machines'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsMachine } from '@/features/settings/SettingsMachineScope'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'

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
const machinesRow = (): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-popup-menu] button')).find(
    (entry) => entry.textContent?.startsWith('Machines'),
  )
it('lists Machines while signed out, counting This Mac where it runs lanes plus Hosts that are up', async () => {
  await render()
  await click('Sign in')
  expect(machinesRow()?.textContent).toBe('Machines 2 online')
  useMachinesStore.setState({ view: { kind: 'machine', id: 'one' } })
  await act(async () => machinesRow()?.click())
  expect(useMachinesStore.getState().view).toEqual({ kind: 'list' })
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <AccountFooter />
      </PlatformProvider>,
    ),
  )
  await click('Sign in')
  expect(machinesRow()?.textContent).toBe('Machines 1 online')
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

it('opens Settings through the shell navigation with the current machine', async () => {
  account = { account: { status: 'signed-in', user, remembered: true } }
  const navigate = vi.fn<(next: Location) => void>()
  const location: Location = { to: 'lanes', machine: 'host-a' }
  // The browser projects its URL's machine into the switcher (useBrowserNavigation).
  useRemoteLanesStore.setState({ filter: 'host-a' })
  await act(async () =>
    root.render(
      <NavigationProvider value={{ location, navigate }}>
        <AccountFooter />
      </NavigationProvider>,
    ),
  )
  await click('Settings')
  expect(navigate).toHaveBeenLastCalledWith({ to: 'page', page: 'settings', machine: 'host-a' })
  await click('Your account')
  await click('Settings')
  expect(navigate).toHaveBeenCalledTimes(2)
  expect(useSettingsUiStore.getState().open).toBe(false)
  useRemoteLanesStore.setState({ filter: 'all' })
})
it('offers no Cancel for a sign-in the client cannot cancel', async () => {
  account = { account: { status: 'signing-in' } }
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <AccountFooter />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).toContain('Finish in your browser')
  expect(
    Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Cancel'),
  ).toBe(false)
})
it('advertises the Settings shortcut only where the app shortcuts are installed', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <AccountFooter />
      </PlatformProvider>,
    ),
  )
  expect(button('Settings').getAttribute('aria-description')).toBeNull()
  expect(button('Settings').getAttribute('data-tooltip')).toBe('Settings')
  await click('Sign in')
  expect(
    Array.from(document.querySelectorAll('[data-popup-menu] button')).find((b) =>
      b.textContent?.startsWith('Settings'),
    )?.textContent,
  ).toBe('Settings ')
})

it('opens Desktop Settings on This Mac when the switcher chose it over the active Host lane', async () => {
  useLayoutStore.setState({ page: null })
  useRemoteLanesStore.setState({ filter: 'local' })
  useMachinesStore.setState({ machines: [{ id: 'bee1', label: 'bee1' } as never] })
  useSessionsStore.setState({
    activeSessionId: 'remote',
    live: {
      remote: {
        sessionId: 'remote',
        workspacePath: 'host:bee1/lane:lane-1',
        target: { kind: 'remote', hostId: 'bee1' },
        laneId: 'lane-1',
      },
    } as never,
  })
  let configured: string | undefined
  function Configuring(): null {
    configured = useSettingsMachine().machine?.id
    return null
  }
  try {
    await act(async () =>
      root.render(
        <>
          <AccountFooter />
          <Configuring />
        </>,
      ),
    )
    await click('Settings')
    expect(useSettingsUiStore.getState().open).toBe(true)
    expect(configured).toBe('local')
  } finally {
    useRemoteLanesStore.setState({ filter: 'all' })
    useMachinesStore.setState({ machines: [] })
    useSessionsStore.setState({ activeSessionId: null, live: {} })
  }
})
