// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageShell } from './PageShell'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useLayoutStore.setState({ page: 'machines' })
  useSessionsStore.setState({ activeSessionId: 'existing-lane' })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useLayoutStore.setState({ page: null })
  useSessionsStore.setState({ activeSessionId: null })
  vi.unstubAllGlobals()
})

it.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])(
  'renders the same title, actions and full content in $formFactor',
  (platform) => {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <PageShell title="Machines" actions={<button>Add machine</button>}>
            <section>Full machine inventory</section>
          </PageShell>
        </PlatformProvider>,
      ),
    )
    expect(container.textContent).toContain('Machines')
    expect(container.querySelector('button')?.textContent).toBe('Add machine')
    expect(container.querySelector('section')?.textContent).toBe('Full machine inventory')
  },
)

it('Desktop close uncovers the active lane without deactivating it', () => {
  act(() => root.render(<PageShell title="Machines">Inventory</PageShell>))
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close page"]')?.click())
  expect(useLayoutStore.getState().page).toBeNull()
  expect(useSessionsStore.getState().activeSessionId).toBe('existing-lane')
})

it('a wide browser close navigates back to machine lanes without mutating Desktop state', () => {
  const navigate = vi.fn()
  act(() =>
    root.render(
      <PlatformProvider value={{ ...COMPACT_PLATFORM, formFactor: 'expanded' }}>
        <NavigationProvider
          value={{ location: { to: 'page', page: 'machines', machine: 'bee1' }, navigate }}
        >
          <PageShell title="Machines">Inventory</PageShell>
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close page"]')?.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'lanes', machine: 'bee1' })
  expect(useLayoutStore.getState().page).toBe('machines')
  expect(useSessionsStore.getState().activeSessionId).toBe('existing-lane')
})

it('a phone page is a tab root, so it has no close button', () => {
  act(() =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <PageShell title="Machines">Inventory</PageShell>
      </PlatformProvider>,
    ),
  )
  expect(container.querySelector('[aria-label="Close page"]')).toBeNull()
})

import { NavigationProvider } from '@/navigation/Navigation'

it('lets a wide page put its header across the full width', () => {
  act(() =>
    root.render(
      <PlatformProvider value={DESKTOP_PLATFORM}>
        <PageShell title="Brain" wide>
          <section />
        </PageShell>
      </PlatformProvider>,
    ),
  )
  expect(container.querySelector('.page-shell')?.classList).toContain('page-shell--wide')
})
