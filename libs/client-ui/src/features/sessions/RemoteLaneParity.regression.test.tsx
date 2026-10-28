// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { HostHome } from '@/features/home/HostHome'
import { useRemoteComposer } from '@/features/home/remoteComposer'
import { OnThisMachine } from '@/features/machines/OnThisMachine'
import { NavigationProvider } from '@/navigation/Navigation'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { CompactLanes } from '@/shell/compact/CompactLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { RemoteLanes } from './RemoteLanes'

/*
 * Every surface that lists Host lanes renders one row with one menu and one group header.
 * The browser's list and Host home used to render a navigation-only row: no menu, no delete.
 */

const SURFACES = ['desktop', 'browser', 'home', 'machine'] as const
type Surface = (typeof SURFACES)[number]
const SECOND = '0000000000000002'
const READER_MENU = [
  'Open',
  'Rename',
  'Take control',
  'Stop',
  'Mark read',
  'Pin',
  'Lane marker',
  'Copy debug info',
  'Copy spend',
  'Delete',
]

let root: Root, el: HTMLDivElement
const invoke = vi.fn()
const navigate = vi.fn()

function host(edit: (view: HostConnectionView) => void = () => {}): void {
  const view = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  view.laneMarks = true
  view.capabilities.push('workspaces.write')
  view.repositories.push({ id: SECOND, name: 'Second project', path: '/second' })
  edit(view)
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: view },
    filter: MOCK_HOST_ID,
    snapshotStatus: 'ready',
  })
}
function lane(): HostConnectionView['lanes'][number] {
  return useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!
}
function surface(name: Surface): React.ReactNode {
  if (name === 'desktop') return <RemoteLanes />
  if (name === 'home') return <HostHome hostId={MOCK_HOST_ID} />
  if (name === 'machine') return <OnThisMachine hostId={MOCK_HOST_ID} />
  return <CompactLanes />
}
function render(name: Surface, platform = DESKTOP_PLATFORM): void {
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
          {surface(name)}
          <ContextMenuHost />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
const row = (): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-testid=remote-session-row]')!
/** A mouse right-click: a press starts the gesture, so each click opens its own menu. */
function rightClick(): void {
  act(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      row().dispatchEvent(event)
    }
    row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
}
function menuRows(): HTMLButtonElement[] {
  return [
    ...(document
      .querySelector('[data-testid=context-menu]')
      ?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ]
}
function menuRow(label: string): HTMLButtonElement | undefined {
  return menuRows().find((b) => b.textContent?.startsWith(label))
}
const labels = (rows: HTMLButtonElement[]): string[] =>
  rows.map((b) => b.querySelector('span')?.textContent ?? b.textContent ?? '')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  invoke.mockReset().mockResolvedValue(undefined)
  navigate.mockReset()
  useMachinesStore.setState({
    remoteEnabled: true,
    loading: false,
    error: null,
    machines: [
      {
        id: MOCK_HOST_ID,
        label: 'Test Host',
        hostname: 'test',
        platform: 'linux',
        arch: 'arm64',
        hostVersion: null,
        keyFingerprint: 'test',
        enrolledAt: '2026-09-10T00:00:00.000Z',
        lastSeenAt: null,
        state: null,
        readiness: null,
        lanes: null,
        endpoint: null,
      },
    ],
  })
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {}, bulkDelete: null })
  useRemoteComposer.setState({ target: null, repositories: {} })
  host()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['desktop', 'browser', 'home'] as const)(
  '%s groups known repositories in snapshot order and preserves unknown-folder lanes',
  (name) => {
    host((view) => {
      const first = { ...view.lanes[0]!, activity: 'stopped' as const }
      view.lanes = [
        { ...first, laneId: 'second', repositoryId: SECOND, title: 'Second lane' },
        { ...first, laneId: 'first', title: 'First lane' },
        { ...first, laneId: 'orphan', repositoryId: '0000000000000003', title: null },
      ]
    })
    render(name)
    const text = el.textContent!
    expect(text.indexOf('First lane')).toBeLessThan(text.indexOf('Second lane'))
    expect(text).toContain('Second project')
    expect(text).toContain('Unavailable folder')
    expect(text).toContain('Untitled lane')
  },
)

it.each(SURFACES)('%s row opens the same lane menu on right-click', (name) => {
  render(name)
  rightClick()
  expect(labels(menuRows())).toEqual(READER_MENU)
  expect(menuRow('Delete')?.textContent).toContain('Take control first.')
})

it.each(SURFACES)('%s row lets the controller delete the lane', (name) => {
  host((view) => {
    view.lanes[0]!.control.controller = { label: 'You', connected: true, self: true }
  })
  render(name)
  rightClick()
  expect(menuRow('Delete')?.disabled).toBe(false)
  act(() => menuRow('Delete')!.click())
  expect(document.body.textContent).toContain('Delete session')
})

it.each(SURFACES)('%s row opens through navigation, so both shells route the lane', (name) => {
  render(name)
  act(() => row().click())
  // No pane: Desktop restores the lane's own pane; the browser's lane URL defaults to chat.
  expect(navigate).toHaveBeenCalledWith({
    to: 'lane',
    lane: { hostId: MOCK_HOST_ID, laneId: lane().laneId },
  })
  expect(invoke).not.toHaveBeenCalledWith('hosts:openLane', MOCK_HOST_ID, lane().laneId)
})

it('a touch long-press on a phone opens the lane menu as a sheet and vibrates once', () => {
  vi.useFakeTimers()
  const vibrate = vi.fn()
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
  render('browser', COMPACT_PLATFORM)
  act(() => {
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    Object.defineProperty(down, 'pointerType', { value: 'touch' })
    row().dispatchEvent(down)
  })
  act(() => void vi.advanceTimersByTime(500))
  const sheet = document.querySelector('[role=dialog]')
  expect(sheet?.getAttribute('aria-label')).toBe('Remote demo lane')
  expect(sheet?.textContent).toContain('Lane marker')
  expect(vibrate).toHaveBeenCalledTimes(1)
  Reflect.deleteProperty(navigator, 'vibrate')
})

it.each(['desktop', 'browser'] as const)(
  '%s Pin and Lane marker write the Host through hosts:setLaneMarks',
  async (name) => {
    render(name)
    rightClick()
    expect(menuRow('Pin')?.disabled).toBe(false)
    await act(async () => menuRow('Pin')!.click())
    expect(invoke).toHaveBeenCalledWith('hosts:setLaneMarks', MOCK_HOST_ID, lane().laneId, {
      pinned: true,
    })
    expect(useSessionsStore.getState().pinned).toEqual([])
    rightClick()
    act(() => menuRow('Lane marker')!.click())
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('None'))!
        .click(),
    )
    expect(invoke).toHaveBeenCalledWith('hosts:setLaneMarks', MOCK_HOST_ID, lane().laneId, {
      marker: '',
    })
    expect(useSessionsStore.getState().laneMarkers).toEqual({})
  },
)

it.each(['desktop', 'browser'] as const)(
  '%s disables Pin and Lane marker with an update hint when the Host keeps no marks',
  (name) => {
    host((view) => {
      view.laneMarks = false
    })
    render(name)
    rightClick()
    for (const label of ['Pin', 'Lane marker']) {
      expect(menuRow(label)?.disabled, label).toBe(true)
      expect(menuRow(label)?.textContent, label).toContain('Update this Host')
    }
  },
)

it.each(['desktop', 'browser'] as const)(
  '%s shows a Host pin as a pinned section with the pin icon, not a title prefix',
  (name) => {
    host((view) => {
      view.lanes[0]!.pinned = true
      view.lanes.push({ ...view.lanes[0]!, laneId: 'other', title: 'Other lane', pinned: false })
    })
    render(name)
    expect(el.textContent).toContain('Pinned')
    expect(el.textContent).not.toContain('⌖')
    const rows = [...el.querySelectorAll('[data-testid=remote-session-row]')]
    expect(rows[0]?.getAttribute('aria-label')).toBe('Remote demo lane')
    expect(rows[0]?.querySelector('[data-testid=lane-pin]')).not.toBeNull()
    expect(rows[1]?.querySelector('[data-testid=lane-pin]')).toBeNull()
    rightClick()
    expect(menuRow('Unpin')).toBeDefined()
  },
)

it.each(['desktop', 'browser', 'home'] as const)(
  '%s group header has search, workspace options with lane selection, and a new lane',
  (name) => {
    render(name)
    const header = (label: string) =>
      el.querySelector<HTMLButtonElement>(`[aria-label="${label} Demo repository"]`)
    expect(header('Search lanes in')).not.toBeNull()
    act(() => header('Workspace options for')!.click())
    const select = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Select all lanes',
    )
    expect(select?.disabled).toBe(false)
    act(() => select!.click())
    expect(el.querySelectorAll('[role=checkbox]').length).toBeGreaterThan(0)
    act(() => header('New lane in')!.click())
    expect(navigate).toHaveBeenCalledWith({ to: 'new', machine: MOCK_HOST_ID })
    expect(useRemoteComposer.getState().repositories[MOCK_HOST_ID]).toBe('0000000000000001')
  },
)

it('the browser offers Add folder on a ready Host with no folders, as Desktop does', () => {
  host((view) => {
    view.repositories = []
    view.lanes = []
  })
  render('browser')
  expect(el.textContent).toContain('No folders yet')
  expect(
    [...el.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Add folder')),
  ).toBe(true)
})
