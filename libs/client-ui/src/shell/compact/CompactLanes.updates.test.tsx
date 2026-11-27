// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationProvider } from '@/navigation/Navigation'
import {
  COMPACT_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { CompactLanes } from './CompactLanes'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: { invoke: vi.fn(async () => undefined), onUpdateEvent: () => () => {} },
  })
  useMachinesStore.setState({ machines: [], loading: false, error: null })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'all', error: null })
})
afterEach(() => vi.unstubAllGlobals())

async function footers(platform: Platform): Promise<number> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate: vi.fn() }}>
          <CompactLanes />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
  const count = element.querySelectorAll('[data-testid="updates-footer"]').length
  await act(async () => root.unmount())
  element.remove()
  return count
}

it('gives a phone the machine update row on its Lanes page; a wide browser has it in the sidebar', async () => {
  expect(await footers(COMPACT_PLATFORM)).toBe(1)
  expect(await footers(WIDE_BROWSER_PLATFORM)).toBe(0)
})
