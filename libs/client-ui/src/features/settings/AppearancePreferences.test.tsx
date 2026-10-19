// @vitest-environment jsdom
import { act } from 'react'
import type { AccountView } from '@shared/account'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { AppearanceTab } from './tabs/AppearanceTab'
import { CompactSettings } from '@/shell/compact/CompactSettings'
import { useSettingsStore } from '@/stores/settings'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'

vi.hoisted(() =>
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  }),
)
vi.mock('@/features/files/MachineFilesPane', () => ({ MachineFilesPane: () => null }))
let root: Root
let container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const theme = vi.fn()
const navigate = vi.fn()
const signOut = vi.fn<() => Promise<AccountView>>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  theme.mockReset()
  navigate.mockReset()
  signOut
    .mockReset()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ account: { status: 'signed-out' } })
  fake = createFakePhosphor({
    'app:setTheme': theme,
    'app:setFontPrefs': () => {},
    'account:signOut': signOut,
  })
  restore = installFakePhosphor(fake)
  useSettingsStore.setState({ theme: 'dark' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
async function compact(): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider
          value={{ location: { to: 'page', page: 'settings', machine: 'bee1' }, navigate }}
        >
          <CompactSettings machine="bee1" />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.toLowerCase() === label.toLowerCase(),
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
}
it('Desktop appearance applies theme and exposes its font controls', async () => {
  await act(async () => root.render(<AppearanceTab />))
  expect(container.querySelector('[role="group"][aria-label="Theme"]')).not.toBeNull()
  await click('Light')
  expect(theme).toHaveBeenCalledWith('light')
  expect(container.textContent).toContain('Chat font size')
  expect(container.textContent).toContain('Terminal font size')
})
it('browser settings keeps page links scoped and recovers sign-out after failure', async () => {
  await compact()
  await click('Skills')
  expect(navigate).toHaveBeenCalledWith({ to: 'page', page: 'skills', machine: 'bee1' })
  await click('Light')
  expect(theme).toHaveBeenCalledWith('light')
  await click('Sign out')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not sign out')
  await click('Sign out')
  expect(signOut).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('browser appearance offers the shared font preferences without Desktop-only controls', async () => {
  await compact()
  expect(container.textContent).toContain('Chat font size')
  expect(container.querySelector('[aria-label="Mono font"]')).not.toBeNull()
  expect(container.textContent).not.toContain('UI scale')
  expect(container.textContent).not.toContain('Editor font size')
  expect(container.textContent).not.toContain('Terminal font size')
})

it('wide browser preferences stay browser-safe and use the same font persistence as Desktop', async () => {
  const invoke = vi.spyOn(fake.api, 'invoke')
  try {
    await act(async () =>
      root.render(
        <PlatformProvider value={{ ...COMPACT_PLATFORM, formFactor: 'expanded' }}>
          <CompactSettings />
        </PlatformProvider>,
      ),
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('UI scale')
    expect(container.textContent).not.toContain('Terminal font size')
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Mono font"]')!
    await act(async () => {
      select.value = 'monospace'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith(
      'app:setFontPrefs',
      expect.objectContaining({ monoFont: 'monospace' }),
    )
    await act(async () => root.render(<AppearanceTab />))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Mono font"]')?.value).toBe(
      'monospace',
    )
  } finally {
    invoke.mockRestore()
  }
})
