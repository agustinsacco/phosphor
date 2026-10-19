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
