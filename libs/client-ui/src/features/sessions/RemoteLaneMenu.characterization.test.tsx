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

it('characterizes the Desktop Host lane menu for a reader: control first, then the rest', () => {
  render(host(false))
  expect(menuRows()).toEqual([
    ['Open', false],
    ['RenameTake control first.', true],
    ['Take control', false],
    ['StopTake control first.', true],
    ['Mark read', false],
    ['Pin', false],
    ['Lane marker', false],
    ['Copy debug info', false],
    ['Copy spend', false],
    ['DeleteTake control first.', true],
  ])
})

it('characterizes the Desktop Host lane menu for the controller', () => {
  render(host(true))
  expect(menuRows()).toEqual([
    ['Open', false],
    ['Rename', false],
    ['Release control', false],
    ['Stop', false],
    ['Mark read', false],
    ['Pin', false],
    ['Lane marker', false],
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
    ['Add folder on 00000000-0000-4000-8000-000000000099…', false],
    ['Remove from 00000000-0000-4000-8000-000000000099', false],
    ['Move up', true],
    ['Move down', true],
    ['Select all lanes', false],
    ['Select merged lanes', false],
    ['Collapse lanes', false],
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
