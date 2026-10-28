// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { SessionMenu } from '@/features/chat/SessionMenu'
import { RemoteLanes } from '@/features/sessions/RemoteLanes'
import { visibleSections } from '@/features/settings/settingsIndex'
import { NavigationProvider } from '@/navigation/Navigation'
import { CompactLanes } from '@/shell/compact/CompactLanes'
import { useChatStore } from '@/stores/chat'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from './Platform'

/*
 * One Host lane offers the same lane menu and Session options on Desktop, in a
 * wide browser and on a phone, and Settings differs between Desktop and the
 * browser only by the capabilities Platform.test.ts lists. The menu host sits
 * outside the platform, so a popover and a phone's sheet compare as the same rows.
 */

const LOCAL = 'local-lane'
const HOST_LANE = mockRemoteInfo.sessionId
const BROWSER_LISTS: [string, Platform, () => React.ReactNode][] = [
  ['wide browser navigation', WIDE_BROWSER_PLATFORM, () => <RemoteLanes />],
  ['wide browser Lanes page', WIDE_BROWSER_PLATFORM, () => <CompactLanes />],
  ['phone navigation', COMPACT_PLATFORM, () => <RemoteLanes />],
  ['phone Lanes page', COMPACT_PLATFORM, () => <CompactLanes />],
]
const invoke = vi.fn()
let root: Root | null = null
let el: HTMLDivElement

function host(self: boolean): void {
  const hosts = structuredClone(mockRemoteHosts)
  const view = hosts[MOCK_HOST_ID]!
  view.laneMarks = true
  view.lanes[0]!.control.controller = { label: 'A client', connected: true, self }
  useRemoteLanesStore.setState({ hosts, filter: MOCK_HOST_ID, snapshotStatus: 'ready' })
}
function render(platform: Platform, node: React.ReactNode): void {
  if (root) act(() => root!.unmount())
  root = createRoot(el)
  act(() =>
    root!.render(
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate: vi.fn() }}>
        <PlatformProvider value={platform}>{node}</PlatformProvider>
        <ContextMenuHost />
      </NavigationProvider>,
    ),
  )
}
interface Row {
  label: string
  text: string
  disabled: boolean
}
const menu = (): Row[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-testid=context-menu] button')].map(
    (b) => ({
      label: b.querySelector('span')?.textContent ?? '',
      text: b.textContent ?? '',
      disabled: b.disabled,
    }),
  )
/** The lane row's menu, opened the way a mouse does on every client. */
function laneMenu(platform: Platform, node: React.ReactNode): Row[] {
  render(platform, node)
  const row = el.querySelector('[data-testid=remote-session-row]')!
  act(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      row.dispatchEvent(event)
    }
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  return menu()
}
function sessionOptions(platform: Platform, sessionId: string): Row[] {
  render(platform, <SessionMenu sessionId={sessionId} />)
  act(() => el.querySelector<HTMLButtonElement>('[aria-label="Session options"]')!.click())
  return menu()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, piCommand: vi.fn() })
  invoke.mockReset().mockResolvedValue(undefined)
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
  useSessionsStore.setState({
    live: {
      [LOCAL]: { phosphorId: LOCAL, workspacePath: '/w' },
      [HOST_LANE]: { ...mockRemoteInfo, phosphorId: HOST_LANE },
    },
    pinned: [],
    laneMarkers: {},
    bulkDelete: null,
  })
  useChatStore.setState({ sessions: {} })
  for (const id of [LOCAL, HOST_LANE]) {
    useChatStore.getState().ensure(id)
    useChatStore.getState().setMeta(id, {
      sessionId: id,
      sessionName: 'Work',
      isStreaming: false,
      isCompacting: false,
      thinkingLevel: 'off',
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 0,
    })
  }
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  el.remove()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'every Host lane list on every client offers the Desktop sidebar menu (controller: %s)',
  (self) => {
    host(self)
    const desktop = laneMenu(DESKTOP_PLATFORM, <RemoteLanes />)
    expect(desktop.map((row) => row.label)).toContain('Delete')
    for (const [name, platform, list] of BROWSER_LISTS)
      expect(laneMenu(platform, list()), name).toEqual(desktop)
  },
)

it.each([false, true])(
  'a Host lane offers the same Session options on every client (controller: %s)',
  (self) => {
    host(self)
    const desktop = sessionOptions(DESKTOP_PLATFORM, HOST_LANE)
    expect(desktop.length).toBeGreaterThan(1)
    for (const platform of [WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM])
      expect(sessionOptions(platform, HOST_LANE)).toEqual(desktop)
  },
)

it("This Mac's lanes list the same Session options; only export needs the lane on this machine", () => {
  host(true)
  const local = sessionOptions(DESKTOP_PLATFORM, LOCAL)
  const remote = sessionOptions(DESKTOP_PLATFORM, HOST_LANE)
  expect(remote.map((row) => row.label)).toEqual(local.map((row) => row.label))
  expect(local.filter((row) => row.disabled)).toEqual([])
  expect(remote.filter((row) => row.disabled).map((row) => row.label)).toEqual(['Export HTML…'])
})

it('Settings differs between clients only by the capabilities each declares', () => {
  const ids = (platform: Platform, machine: 'local' | 'host' | null): string[] =>
    visibleSections(platform, machine).map((section) => section.id)
  for (const machine of ['local', 'host', null] as const)
    expect(ids(COMPACT_PLATFORM, machine)).toEqual(ids(WIDE_BROWSER_PLATFORM, machine))
  const desktop = ids(DESKTOP_PLATFORM, 'host')
  const browser = ids(WIDE_BROWSER_PLATFORM, 'host')
  // writingAssist and appShortcuts are Desktop's; installableApp is the browser's.
  expect(desktop.filter((id) => !browser.includes(id))).toEqual(['writing', 'keybindings'])
  expect(browser.filter((id) => !desktop.includes(id))).toEqual(['install'])
  // This Mac's own sections need localLanes, so the browser lists none of them.
  expect(ids(WIDE_BROWSER_PLATFORM, 'local')).toEqual(ids(WIDE_BROWSER_PLATFORM, null))
  expect(ids(DESKTOP_PLATFORM, 'local')).toContain('agent')
})
