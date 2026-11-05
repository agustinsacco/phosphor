// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationProvider } from '@/navigation/Navigation'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { CompactSettings } from '@/shell/compact/CompactSettings'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSettingsUiStore } from './settingsUiStore'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})

vi.mock('@/lib/monaco', () => ({}))

const navigate = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async () => undefined),
    platform: 'darwin',
    onAccountChanged: () => () => {},
  })
  useMachinesStore.setState({ machines: [], view: { kind: 'list' } })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'all' })
  useSettingsUiStore.setState({ tab: 'appearance', machine: null, folder: null })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('explains why the browser lists no machine sections, and links to Machines', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider value={{ location: { to: 'page', page: 'settings' }, navigate }}>
          <CompactSettings />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
  expect(container.querySelector('select[aria-label="Configure"]')).toBeNull()
  expect(container.textContent).toContain('No machine to configure')
  const open = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Open Machines',
  )
  await act(async () => open?.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'page', page: 'machines' })
})
