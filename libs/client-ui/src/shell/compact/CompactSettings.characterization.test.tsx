// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { CompactSettings } from './CompactSettings'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'

vi.hoisted(() =>
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }),
)
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const signOut = vi.fn(async () => ({ account: { status: 'signed-out' as const } }))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  signOut.mockClear()
  fake = createFakePhosphor({
    'account:get': () => ({
      account: {
        status: 'signed-in',
        user: { name: 'Ada', login: 'ada', email: null },
        remembered: true,
      },
    }),
    'account:signOut': signOut,
  })
  restore = installFakePhosphor(fake)
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

async function renderPage(): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider
          value={{ location: { to: 'page', page: 'settings' }, navigate: () => undefined }}
        >
          <CompactSettings />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
/** Opens a section when the page lists sections; a page showing everything needs no step. */
async function reveal(section: string): Promise<void> {
  const entry = [...container.querySelectorAll('nav[aria-label="Settings sections"] button')].find(
    (b) => b.textContent?.trim() === section,
  ) as HTMLButtonElement | undefined
  if (entry) await act(async () => entry.click())
}
const heading = (name: string): Element | undefined =>
  [...container.querySelectorAll('h1, h2, h3')].find((h) => h.textContent?.trim() === name)

it('shows the browser Settings page with the shared theme rows first', async () => {
  await renderPage()
  expect(heading('Settings')).toBeDefined()
  expect(container.querySelector('[role="group"][aria-label="Theme"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Mono font"]')).not.toBeNull()
})

it('reaches App installation with the in-app attention note', async () => {
  await renderPage()
  await reveal('App installation')
  expect(heading('App installation')).toBeDefined()
  expect(container.textContent).toContain('Push notifications are not available yet.')
})

it('reaches Sign out for the Phosphor account', async () => {
  await renderPage()
  await reveal('Phosphor account')
  const button = buttonNamed('Sign out')
  expect(button).toBeDefined()
  await act(async () => button?.click())
  expect(signOut).toHaveBeenCalledTimes(1)
})
