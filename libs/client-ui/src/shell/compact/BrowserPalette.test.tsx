// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import {
  COMPACT_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { usePaletteStore } from '@/features/palette/paletteStore'
import { useRemoteComposer } from '@/features/home/remoteComposer'
import { BrowserPalette } from './BrowserPalette'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({}))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
const navigate = vi.fn()
const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.palette-results button'),
]
const labels = (): string[] => rows().map((row) => row.textContent ?? '')
function render(platform: Platform): void {
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
          <BrowserPalette />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
function query(text: string): void {
  const input = document.querySelector<HTMLInputElement>('.palette-input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(code: string, cancelable = true): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: code.slice(-1).toLowerCase(),
    code,
    ctrlKey: true,
    bubbles: true,
    cancelable,
  })
  act(() => window.dispatchEvent(event))
  return event
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  fake = createFakePhosphor({ 'app:setLastSession': () => {} })
  restore = installFakePhosphor(fake)
  navigate.mockReset()
  useSessionsStore.setState({ activeSessionId: null, live: {}, disk: {} })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'local' })
  usePaletteStore.setState({ open: true })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  usePaletteStore.setState({ open: false })
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
it('phone and wide browsers list the same pages, theme and Host actions without native commands', () => {
  render(WIDE_BROWSER_PLATFORM)
  const wide = labels()
  expect(wide.slice(0, 6)).toEqual([
    'Go to Home',
    'Go to Machines',
    'Go to Skills',
    'Go to Routines',
    'Go to Artifacts',
    'Go to Settings',
  ])
  render(COMPACT_PLATFORM)
  expect(labels()).toEqual(wide)
  expect(document.querySelector('[data-compact-sheet] .palette-dialog')).not.toBeNull()
  expect(document.activeElement).toBe(document.querySelector('.palette-input'))
  for (const text of [
    'feedback',
    'Keyboard shortcuts',
    'Rewind',
    'Toggle',
    'workspace',
    'Open session',
  ]) {
    query(text)
    expect(rows()).toHaveLength(0)
  }
  query('Theme: dark')
  expect(labels()).toEqual(['Theme: dark'])
})
it('filters native commands by their declared capabilities', () => {
  useSessionsStore.setState({ activeSessionId: 'lane' })
  render({ ...WIDE_BROWSER_PLATFORM, feedback: true, appShortcuts: true, splitPanes: true })
  query('feedback')
  expect(labels()).toEqual(['Send feedback'])
  query('Keyboard shortcuts')
  expect(rows()).toHaveLength(1)
  query('Toggle')
  expect(rows()).toHaveLength(6)
})
it('searches every Host and folder before bounding results, then navigates to the qualified lane', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const lane = host.lanes[0]!
  host.lanes = Array.from({ length: 30 }, (_, i) => ({
    ...lane,
    laneId: `lane-${i}`,
    title: i === 29 ? 'Needle beyond the bound' : `Work ${i}`,
    activity: 'needs-input',
  }))
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: mockRemoteHosts[MOCK_HOST_ID]!, 'second-host': host },
  })
  render(WIDE_BROWSER_PLATFORM)
  expect(rows().length).toBeLessThanOrEqual(12)
  query('Needle beyond the bound')
  expect(labels()).toEqual([
    `Open lane: Needle beyond the boundNeeds yousecond-host · ${host.repositories[0]!.name}`,
  ])
  act(() => rows()[0]!.click())
  expect(navigate).toHaveBeenCalledWith({
    to: 'lane',
    lane: { hostId: 'second-host', laneId: 'lane-29' },
    pane: 'chat',
  })
  act(() => usePaletteStore.getState().setOpen(true))
  query(`second-host ${host.repositories[0]!.name}`)
  expect(labels().some((label) => label.startsWith('Open lane: Work'))).toBe(true)
})
it('routes pages and new lanes through browser history with the chosen Host folder', () => {
  render(COMPACT_PLATFORM)
  query('Go to Settings')
  act(() => rows()[0]!.click())
  expect(navigate).toHaveBeenLastCalledWith({ to: 'page', page: 'settings' })
  act(() => usePaletteStore.getState().setOpen(true))
  const repository = mockRemoteHosts[MOCK_HOST_ID]!.repositories[0]!
  query(`New lane on ${MOCK_HOST_ID}/${repository.name}`)
  act(() => rows()[0]!.click())
  expect(navigate).toHaveBeenLastCalledWith({ to: 'new', machine: MOCK_HOST_ID })
  expect(useRemoteComposer.getState().target).toEqual({
    hostId: MOCK_HOST_ID,
    repositoryId: repository.id,
  })
})
it('takes cancelable Ctrl+K in a wide browser only; native Find elsewhere stays untouched', () => {
  usePaletteStore.setState({ open: false })
  render(WIDE_BROWSER_PLATFORM)
  expect(key('KeyK', false).defaultPrevented).toBe(false)
  expect(usePaletteStore.getState().open).toBe(false)
  expect(key('KeyK').defaultPrevented).toBe(true)
  expect(usePaletteStore.getState().open).toBe(true)
  expect(key('KeyK').defaultPrevented).toBe(true)
  expect(usePaletteStore.getState().open).toBe(false)
  expect(key('KeyF').defaultPrevented).toBe(false)
  render(COMPACT_PLATFORM)
  expect(key('KeyK').defaultPrevented).toBe(false)
  expect(usePaletteStore.getState().open).toBe(false)
  expect(COMPACT_PLATFORM.appShortcuts).toBe(false)
})
