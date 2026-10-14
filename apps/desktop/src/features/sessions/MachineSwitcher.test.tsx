// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineSwitcher, otherMachineActivity } from './MachineSwitcher'
import { RemoteLanes } from './RemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  invoke.mockReset().mockRejectedValue(new Error('unavailable'))
  localStorage.clear()
  useMachinesStore.setState({ remoteEnabled: true, machines: [], adding: false })
  useSessionsStore.setState({ live: {}, unread: {}, disk: {}, seenSessions: {} })
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    filter: 'all',
    error: null,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
function click(label: string): void {
  const b = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!b) throw new Error(`Missing ${label}`)
  act(() => b.click())
}
function choose(text: string): void {
  click('Machine filter')
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) =>
    o.textContent?.includes(text),
  )
  if (!option) throw new Error(`Missing option ${text}`)
  act(() => option.click())
}
it('defaults to This Mac on every mount without persisting selection', () => {
  localStorage.setItem('machineFilter', MOCK_HOST_ID)
  act(() => root.render(<MachineSwitcher />))
  expect(useRemoteLanesStore.getState().filter).toBe('local')
  choose(MOCK_HOST_ID)
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(localStorage.getItem('machineFilter')).toBe(MOCK_HOST_ID)
  expect(localStorage.length).toBe(1)
  act(() => root.render(null))
  act(() => root.render(<MachineSwitcher />))
  expect(useRemoteLanesStore.getState().filter).toBe('local')
})
it('excludes selected machine and All machines from other activity', () => {
  const counts = {
    local: { running: 1, new: 2, needsYou: 0 },
    host: { running: 3, new: 4, needsYou: 1 },
  }
  expect(otherMachineActivity(counts, 'host')).toEqual(counts.local)
  expect(otherMachineActivity(counts, 'local')).toEqual(counts.host)
  expect(otherMachineActivity(counts, 'all')).toEqual({ running: 0, new: 0, needsYou: 0 })
  act(() => root.render(<MachineSwitcher />))
  expect(
    container.querySelector('[aria-label="Activity on other machines"]')?.textContent,
  ).toContain('1 new')
  choose(MOCK_HOST_ID)
  expect(container.querySelector('[aria-label="Activity on other machines"]')).toBeNull()
})
it('navigates by keyboard, Enter selects, Escape closes and returns focus, outside click dismisses', () => {
  act(() => root.render(<MachineSwitcher />))
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Machine filter"]')!
  trigger.focus()
  click('Machine filter')
  act(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  )
  act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(document.activeElement).toBe(trigger)
  click('Machine filter')
  act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[role=listbox]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  click('Machine filter')
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(container.querySelector('[role=listbox]')).toBeNull()
})
it('Add machine opens the existing Machines add flow even without Hosts', () => {
  useRemoteLanesStore.setState({ hosts: {} })
  act(() => root.render(<MachineSwitcher />))
  choose('Add machine')
  expect(useLayoutStore.getState().page).toBe('machines')
  expect(useMachinesStore.getState().adding).toBe(true)
  expect(useMachinesStore.getState().view).toEqual({ kind: 'list' })
})
it('hides when signed out and resets filter to local', () => {
  useMachinesStore.setState({ remoteEnabled: false })
  act(() =>
    root.render(
      <>
        <MachineSwitcher />
        <RemoteLanes />
      </>,
    ),
  )
  expect(container.textContent).toBe('')
  expect(useRemoteLanesStore.getState().filter).toBe('local')
})
it('All machines groups lanes by configured repository including empty repositories', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: 'second', name: 'Second repository', path: '/private/not-rendered' })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('Demo repository')
  expect(container.textContent).toContain('Second repository')
  expect(container.textContent).toContain('No lanes yet')
  expect(container.textContent).not.toContain('/private')
  expect(container.querySelectorAll('[data-testid=remote-session-row]')).toHaveLength(1)
})
it('down keeps last-known rows inert and disables creation; setting up has an explicit empty state', () => {
  const host = { ...mockRemoteHosts[MOCK_HOST_ID]!, state: 'down' as const }
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('last known')
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid=remote-session-row]')?.disabled,
  ).toBe(true)
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="New lane in Demo repository"]')
      ?.disabled,
  ).toBe(true)
  act(() =>
    useRemoteLanesStore.setState({
      hosts: {
        [MOCK_HOST_ID]: { ...host, state: 'no-address', capabilities: [], repositories: [] },
      },
    }),
  )
  expect(container.textContent).toContain('Setting up…')
})
it('repository plus preselects that repository without sending a local creation', async () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: 'second', name: 'Second repository', path: '/private' })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  act(() => root.render(<RemoteLanes />))
  click('New lane in Second repository')
  expect(document.querySelector('button[aria-label=Repository]')?.textContent).toContain(
    'Second repository',
  )
  await act(async () =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(invoke).toHaveBeenCalledExactlyOnceWith('hosts:createLane', MOCK_HOST_ID, {
    repositoryId: 'second',
  })
})
