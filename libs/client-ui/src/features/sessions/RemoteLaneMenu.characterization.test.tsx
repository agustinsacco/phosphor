// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@shared/ipc'
import { RemoteLanes } from './RemoteLanes'

/* Desktop's Host lane menu and group header, as they read before the browser shared them. */

let root: Root
let container: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(undefined)

function host(self: boolean, state: HostConnectionView['state'] = 'ready'): HostConnectionView {
  const view = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  view.state = state
  view.laneMarks = true
  view.capabilities.push('workspaces.write')
  view.lanes[0]!.control.controller = self
    ? { label: 'You', connected: true, self: true }
    : { label: 'Another Desktop', connected: true, self: false }
  return view
}
function render(view: HostConnectionView): void {
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: view }, filter: MOCK_HOST_ID })
  act(() =>
    root.render(
      <>
        <RemoteLanes />
        <ContextMenuHost />
      </>,
    ),
  )
}
function menuRows(): [string, boolean][] {
  const row = container.querySelector('[data-testid=remote-session-row]')!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menu = document.querySelector('[data-testid=context-menu]')!
  return [...menu.querySelectorAll('button')].map((b) => [b.textContent ?? '', b.disabled])
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  invoke.mockClear()
  useMachinesStore.setState({ remoteEnabled: true })
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {}, bulkDelete: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("characterizes the Desktop Host lane menu for a reader: This Mac's order, control before Stop", () => {
  render(host(false))
  expect(menuRows()).toEqual([
    ['Open', false],
    ['Move upAlt+↑', true],
    ['Move downAlt+↓', true],
    ['Rename…Take control first.', true],
    ['Make routine…This Host does not offer routines to this device.', true],
    ['Pin', false],
    ['Lane marker…', false],
    ['Take control', false],
    ['StopTake control first.', true],
    ['Mark read', false],
    ['Move to…Update this Host to move lanes.', true],
    ['Export HTML…', false],
    ['Copy debug info', false],
    ['Copy spend', false],
    ['DeleteTake control first.', true],
  ])
})

it('characterizes the Desktop Host lane menu for the controller', () => {
  render(host(true))
  expect(menuRows()).toEqual([
    ['Open', false],
    ['Move upAlt+↑', true],
    ['Move downAlt+↓', true],
    ['Rename…', false],
    ['Make routine…This Host does not offer routines to this device.', true],
    ['Pin', false],
    ['Lane marker…', false],
    ['Release control', false],
    ['Stop', false],
    ['Mark read', false],
    ['Move to…Update this Host to move lanes.', true],
    ['Export HTML…', false],
    ['Copy debug info', false],
    ['Copy spend', false],
    ['Delete', false],
  ])
})

it('characterizes the Desktop Host group header: search, options, new lane', () => {
  render(host(true))
  const header = [...container.querySelectorAll('button')]
    .map((b) => b.getAttribute('aria-label'))
    .filter((label) => label?.endsWith('Demo repository'))
  expect(header).toEqual([
    'Search lanes in Demo repository',
    'Workspace options for Demo repository',
    'New lane in Demo repository',
  ])
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Workspace options for Demo repository"]')!
      .click(),
  )
  const rows = [
    ...document.querySelector('[data-popup-menu]')!.querySelectorAll<HTMLButtonElement>('button'),
  ].map((b) => [b.textContent, b.disabled])
  expect(rows).toEqual([
    ['Select all lanes', false],
    ['Select merged lanes', false],
    ['Collapse lanes', false],
    ['Move up', true],
    ['Move down', true],
    ['Remove from 00000000-0000-4000-8000-000000000099', false],
    ['Add folder on 00000000-0000-4000-8000-000000000099…', false],
  ])
})

it('characterizes the last-known badge and the disabled row while a Host reconnects', () => {
  render(host(true, 'reconnecting'))
  expect(container.textContent).toContain('last known')
  const row = container.querySelector<HTMLButtonElement>('[data-testid=remote-session-row]')!
  expect(row.disabled).toBe(true)
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="New lane in Demo repository"]')!
      .disabled,
  ).toBe(true)
})

it('drops Lane marker from the Host lane menu when markers are off', async () => {
  const { useLanePrefsStore } = await import('@/stores/lanePrefs')
  act(() => useLanePrefsStore.getState().applyLanePrefs({ markers: 'off' }))
  render(host(true))
  expect(menuRows().map(([label]) => label)).not.toContain('Lane marker')
  act(() => useLanePrefsStore.getState().applyLanePrefs({ markers: 'auto' }))
})

it('hides Mark read on a read Host lane, as This Mac does', () => {
  const view = host(true)
  view.lanes[0] = { ...view.lanes[0]!, read: view.lanes[0]!.attention }
  render(view)
  expect(menuRows().map(([label]) => label)).not.toContain('Mark read')
})

it("opens the Host lane menu's copies and Delete with a separator, as This Mac does", () => {
  render(host(true))
  menuRows()
  const separated = [...document.querySelectorAll('[data-testid=context-menu] button')]
    .filter((b) => b.previousElementSibling !== null)
    .map((b) => b.textContent)
  expect(separated).toEqual(['Move to…Update this Host to move lanes.', 'Delete'])
})

it('offers Lane marker… on a Host lane only while markers are on', async () => {
  const { useLanePrefsStore } = await import('@/stores/lanePrefs')
  render(host(true))
  expect(menuRows().map(([label]) => label)).toContain('Lane marker…')
  act(() => root.unmount())
  root = createRoot(container)
  act(() => useLanePrefsStore.getState().applyLanePrefs({ markers: 'off' }))
  try {
    render(host(true))
    expect(menuRows().map(([label]) => label)).not.toContain('Lane marker…')
  } finally {
    act(() => useLanePrefsStore.getState().applyLanePrefs({ markers: 'auto' }))
  }
})
