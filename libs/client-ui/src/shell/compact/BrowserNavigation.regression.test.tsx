// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Platform } from '@/platform/Platform'
import { COMPACT_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'
import { MACHINE } from '@/features/machines/__fixtures__/control'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { BrowserShell } from './BrowserShell'
import { useBrowserNavigation } from './useBrowserNavigation'

vi.mock('@/navigation/screens', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GlobalScreen: ({ page }: { page: string }) => <p>{page} surface</p>,
}))
vi.mock('./CompactLane', () => ({ CompactLane: () => <p>Lane surface</p> }))
vi.mock('./CompactNew', () => ({ CompactNew: () => <p>New lane surface</p> }))
vi.mock('./CompactSettings', () => ({ CompactSettings: () => <p>Settings surface</p> }))
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))

const LANE = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'account:get')
        return {
          account: {
            status: 'signed-in',
            user: { login: 'fixture', name: null, email: null },
            remembered: false,
          },
        }
      throw new Error('unavailable')
    }),
    onAccountChanged: () => () => {},
    onUpdateEvent: () => () => {},
  })
  window.history.replaceState(null, '', '/lanes')
  useMachinesStore.setState({
    remoteEnabled: true,
    loading: false,
    error: null,
    machines: [
      { ...MACHINE, id: MOCK_HOST_ID, label: 'Fixture Host' },
      { ...MACHINE, label: 'Second Host' },
    ],
  })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), error: null })
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useLayoutStore.setState({ page: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function Shell(): React.JSX.Element {
  const navigation = useBrowserNavigation()
  return (
    <NavigationProvider value={navigation}>
      <BrowserShell pending={false} />
    </NavigationProvider>
  )
}
async function render(platform: Platform): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <Shell />
      </PlatformProvider>,
    ),
  )
}
const labels = (scope: ParentNode | null | undefined): string[] =>
  [...(scope?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim() ?? '')
const byLabel = (scope: ParentNode, label: string): HTMLButtonElement => {
  const found = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(found, label).not.toBeNull()
  return found!
}
async function chooseMachine(scope: ParentNode, text: string): Promise<void> {
  await act(async () => byLabel(scope, 'Machine filter').click())
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) =>
    o.textContent?.startsWith(text),
  )
  expect(option, text).toBeDefined()
  await act(async () => option!.click())
}
async function openDrawer(): Promise<Element> {
  await act(async () => byLabel(container, 'Open navigation').click())
  return document.querySelector('[role="dialog"][aria-label="Navigation"]')!
}

/** The shared composition, the scope, the Host lane tree, then the footer, in that order. */
function expectSharedNavigation(scope: Element): void {
  expect(labels(scope.querySelector('nav[aria-label="Main navigation"]'))).toEqual([
    'New',
    'Inbox',
    'Artifacts',
    'Skills',
    'Routines',
    'Machines',
  ])
  const machineScope = byLabel(scope, 'Machine filter')
  const lane = scope.querySelector(`button[aria-label="${LANE.title}"]`) ?? undefined
  const footer = scope.querySelector('[data-testid="account-footer"]')
  expect(lane).toBeDefined()
  expect(footer?.querySelector('button[aria-label="Settings"]')).not.toBeNull()
  expect(
    machineScope.compareDocumentPosition(lane!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(lane!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

it('wide: the column renders the shared composition, the machine scope and the Host lane tree', async () => {
  await render(WIDE_BROWSER_PLATFORM)
  expectSharedNavigation(container.querySelector('aside.browser-navigation')!)
  expect(container.querySelector('select[aria-label="Machine filter"]')).toBeNull()
  expect(container.querySelectorAll('button[aria-label="Machine filter"]')).toHaveLength(1)
})

it('phone: the drawer renders the same body, and opening a lane from it closes the drawer', async () => {
  await render(COMPACT_PLATFORM)
  expect(container.querySelector('select[aria-label="Machine filter"]')).toBeNull()
  const drawer = await openDrawer()
  expectSharedNavigation(drawer)
  const lane = drawer.querySelector<HTMLButtonElement>(`button[aria-label="${LANE.title}"]`)!
  await act(async () => lane.click())
  expect(window.location.pathname).toBe(`/lanes/${MOCK_HOST_ID}/${LANE.laneId}/chat`)
  expect(document.querySelector('[aria-label="Navigation"]')).toBeNull()
})

it('choosing a machine in the scope updates the URL, and This Mac is never offered', async () => {
  await render(WIDE_BROWSER_PLATFORM)
  const column = container.querySelector('aside.browser-navigation')!
  await act(async () => byLabel(column, 'Machine filter').click())
  const options = [...document.querySelectorAll('[role=option]')].map((o) => o.textContent ?? '')
  expect(options.some((o) => o.startsWith('This Mac'))).toBe(false)
  expect(options.some((o) => o.startsWith('Fixture Host'))).toBe(true)
  await act(async () => byLabel(column, 'Machine filter').click())
  await chooseMachine(column, 'Second Host')
  expect(window.location.pathname).toBe(`/lanes/${MACHINE.id}`)
  expect(useRemoteLanesStore.getState().filter).toBe(MACHINE.id)
  await chooseMachine(column, 'All machines')
  expect(window.location.pathname).toBe('/lanes')
  expect(useRemoteLanesStore.getState().filter).toBe('all')
})

it('choosing a machine in the drawer keeps it open on that machine', async () => {
  await render(COMPACT_PLATFORM)
  const drawer = await openDrawer()
  await chooseMachine(drawer, 'Fixture Host')
  expect(window.location.pathname).toBe(`/lanes/${MOCK_HOST_ID}`)
  expect(document.querySelector('[aria-label="Navigation"]')).not.toBeNull()
})

it('New and the footer Settings gear navigate through the URL with the current machine', async () => {
  window.history.replaceState(null, '', `/lanes/${MOCK_HOST_ID}`)
  await render(WIDE_BROWSER_PLATFORM)
  const column = container.querySelector('aside.browser-navigation')!
  const nav = column.querySelector('nav[aria-label="Main navigation"]')!
  await act(async () =>
    [...nav.querySelectorAll('button')].find((b) => b.textContent === 'New')!.click(),
  )
  expect(window.location.pathname).toBe(`/new/${MOCK_HOST_ID}`)
  await act(async () => byLabel(column, 'Settings').click())
  expect(window.location.pathname).toBe(`/pages/settings/${MOCK_HOST_ID}`)
})

it('phone: the footer Settings gear closes the drawer and opens Settings for the machine in scope', async () => {
  window.history.replaceState(null, '', `/lanes/${MOCK_HOST_ID}`)
  await render(COMPACT_PLATFORM)
  const drawer = await openDrawer()
  await act(async () => byLabel(drawer, 'Settings').click())
  expect(window.location.pathname).toBe(`/pages/settings/${MOCK_HOST_ID}`)
  expect(document.querySelector('[aria-label="Navigation"]')).toBeNull()
})
