// @vitest-environment jsdom
import { act, Profiler } from 'react'
import { useChatStore } from '@/stores/chat'
import type * as ChatStoreModule from '@/stores/chat'
import { useComposerMachine } from '@/features/home/useComposerMachine'
import { Sidebar } from './Sidebar'
import { useRemoteComposer, rememberRemoteRepository } from '@/features/home/remoteComposer'
import { requestReveal, remoteLaneGroupKey } from './laneReveal'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineSwitcher, MachineLabelLine, otherMachineActivity } from './MachineSwitcher'
import { RemoteLanes } from './RemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.mock('@/stores/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatStoreModule>()
  return { ...actual, useChatStore: Object.assign(vi.fn(actual.useChatStore), actual.useChatStore) }
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke,
      onUpdateEvent: () => () => {},
      onAccountChanged: () => () => {},
      onRoutinesChanged: () => () => {},
      onSessionsChanged: () => () => {},
    },
  })
  invoke.mockReset().mockRejectedValue(new Error('unavailable'))
  localStorage.clear()
  useMachinesStore.setState({ remoteEnabled: true, machines: [], adding: false })
  useSessionsStore.setState({ live: {}, unread: {}, disk: {}, seenSessions: {} })
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    filter: 'local',
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
it('initializes once per renderer, preserves sidebar selection and composer target across remounts', async () => {
  expect(useRemoteLanesStore.getInitialState().filter).toBe('local')
  localStorage.setItem('machineFilter', MOCK_HOST_ID)
  function ComposerTarget(): React.JSX.Element {
    const [machine, setMachine] = useComposerMachine()
    return (
      <>
        <output>{machine}</output>
        <button aria-label="Override local" onClick={() => setMachine('local')}>
          Local override
        </button>
      </>
    )
  }
  const sidebar = (
    <>
      <Sidebar workspacePath="" />
      <ComposerTarget />
    </>
  )
  // Sidebar IPC effects are not part of this selection test.
  invoke.mockImplementation(async (channel) => {
    if (channel === 'app:getPrefs' || channel === 'routines:laneIndex') return {}
    if (channel === 'git:listWorktrees') return []
    return null
  })
  await act(async () => root.render(sidebar))
  choose(MOCK_HOST_ID)
  expect(container.querySelector('output')?.textContent).toBe(MOCK_HOST_ID)
  await act(async () => root.render(<ComposerTarget />))
  await act(async () => root.render(sidebar))
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(container.querySelector('output')?.textContent).toBe(MOCK_HOST_ID)
  expect(localStorage.getItem('machineFilter')).toBe(MOCK_HOST_ID)
  expect(localStorage.length).toBe(1)
  act(() => rememberRemoteRepository(MOCK_HOST_ID, '0000000000000001'))
  click('Override local')
  expect(container.querySelector('output')?.textContent).toBe('local')
  useRemoteComposer.setState({ target: null })
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'New')!.click())
  expect(useRemoteComposer.getState().target).toEqual({
    hostId: MOCK_HOST_ID,
    repositoryId: '0000000000000001',
  })
  act(() => useRemoteLanesStore.getState().setFilter('local'))
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'New')!.click())
  expect(useRemoteComposer.getState().target).toBeNull()
  expect(useSessionsStore.getState().activeSessionId).toBeNull()

  await act(async () => root.render(null))
  act(() => useMachinesStore.getState().enableRemote(false))
  expect(useRemoteLanesStore.getState().filter).toBe('local')
})
it('resets a removed machine even with the sidebar unmounted', () => {
  const machine = { id: MOCK_HOST_ID } as ReturnType<
    typeof useMachinesStore.getState
  >['machines'][number]
  useMachinesStore.setState({ machines: [machine] })
  useRemoteLanesStore.getState().setFilter(MOCK_HOST_ID)
  useMachinesStore.setState({ machines: [] })
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
  useRemoteLanesStore.setState({ filter: 'all' })
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
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
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
  expect(container.textContent).toContain('Not reachable yet')
})
it('repository plus preselects that repository without sending a local creation', async () => {
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: 'second', name: 'Second repository', path: '/private' })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  act(() => root.render(<RemoteLanes />))
  click('New lane in Second repository')
  expect(useRemoteComposer.getState().target).toEqual({
    hostId: MOCK_HOST_ID,
    repositoryId: 'second',
  })
  expect(useSessionsStore.getState().activeSessionId).toBeNull()
  expect(invoke.mock.calls.some(([channel]) => channel === 'hosts:createLane')).toBe(false)
})

it('labels each elsewhere signal and gives the cluster a readable breakdown, without a default caption', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const lane = host.lanes[0]!
  host.lanes = [
    { ...lane, activity: 'working' },
    { ...lane, laneId: 'needs-you', activity: 'needs-input' },
  ]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  act(() => root.render(<MachineSwitcher />))
  const cluster = container.querySelector('[aria-label="Activity on other machines"]')!
  expect(cluster.getAttribute('data-tooltip')).toBe(
    'Other machines: 1 running · 2 new · 1 need you',
  )
  expect(cluster.querySelector('[aria-label="1 running"]')).not.toBeNull()
  expect(cluster.querySelector('[aria-label="2 new"]')).not.toBeNull()
  expect(cluster.querySelector('[aria-label="1 need you"]')).not.toBeNull()
  expect(cluster.textContent).not.toContain('!')
  click('Machine filter')
  expect(container.querySelector('[role=listbox]')?.textContent).not.toContain('default')
})

it('notice reveal expands the Host repository and clears its search', () => {
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
  act(() => root.render(<RemoteLanes />))
  act(() =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Demo repository'))!
      .click(),
  )
  expect(container.querySelector('[data-testid=remote-session-row]')).toBeNull()
  act(() => requestReveal(remoteLaneGroupKey(MOCK_HOST_ID, '0000000000000001')))
  expect(container.querySelector('[data-testid=remote-session-row]')).not.toBeNull()
})
it('content-only chat updates do not rerender the switcher row, while count changes do', () => {
  useChatStore.getState().ensure('local-chat')
  useSessionsStore.setState({
    live: {
      'local-chat': { phosphorId: 'local-chat', workspacePath: '/ws' } as ReturnType<
        typeof useSessionsStore.getState
      >['live'][string],
    },
  })
  const rendered = vi.fn()
  act(() =>
    root.render(
      <Profiler id="switcher" onRender={rendered}>
        <MachineSwitcher />
      </Profiler>,
    ),
  )
  rendered.mockClear()
  act(() => useChatStore.getState().addUserMessage('local-chat', 'A content-only update'))
  expect(rendered).not.toHaveBeenCalled()
  act(() =>
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'local-chat': { ...s.sessions['local-chat']!, isStreaming: true },
      },
    })),
  )
  expect(rendered).toHaveBeenCalledOnce()
})
it('signed-out switcher mounts no chat activity subscriber', () => {
  useMachinesStore.setState({ remoteEnabled: false })
  vi.mocked(useChatStore).mockClear()
  act(() => root.render(<MachineSwitcher />))
  expect(useChatStore).not.toHaveBeenCalled()
})

it('remote All-machines headers mount no local activity subscriber', () => {
  vi.mocked(useChatStore).mockClear()
  act(() => root.render(<MachineLabelLine id={MOCK_HOST_ID} />))
  expect(useChatStore).not.toHaveBeenCalled()
})
it('local All-machines header ignores content-only chat updates', () => {
  const rendered = vi.fn()
  act(() =>
    root.render(
      <Profiler id="local-header" onRender={rendered}>
        <MachineLabelLine id="local" />
      </Profiler>,
    ),
  )
  rendered.mockClear()
  act(() => useChatStore.getState().addUserMessage('local-chat', 'Another content-only update'))
  expect(rendered).not.toHaveBeenCalled()
})

it.each([
  ['mac', 'bee-a', 'mac'],
  ['bee-a', 'bee-b', 'bee-a'],
])('sidebar header follows lane repository, not opaque ids: %j', async (...sequence) => {
  invoke.mockImplementation(async (channel) =>
    channel === 'app:getPrefs' || channel === 'routines:laneIndex'
      ? {}
      : channel === 'git:listWorktrees'
        ? []
        : null,
  )
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({
    id: 'other-repository-id',
    name: 'Other Host repo',
    path: '/host/other',
  })
  host.lanes.push({ ...host.lanes[0]!, laneId: 'other-lane', repositoryId: 'other-repository-id' })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      'bee-a': {
        phosphorId: 'bee-a',
        workspacePath: `host:${MOCK_HOST_ID}/0000000000000001`,
        target: { kind: 'remote', hostId: MOCK_HOST_ID },
        laneId: host.lanes[0]!.laneId,
      },
      'bee-b': {
        phosphorId: 'bee-b',
        workspacePath: `host:${MOCK_HOST_ID}/other-repository-id`,
        target: { kind: 'remote', hostId: MOCK_HOST_ID },
        laneId: 'other-lane',
      },
    },
  })
  for (const id of sequence) {
    await act(async () => {
      useSessionsStore.setState({ activeSessionId: id })
      root.render(<Sidebar workspacePath="" />)
    })
    const header = container.querySelector('[data-testid=workspace-switcher]')
    expect(header?.textContent).toContain(
      id === 'mac' ? 'mac' : id === 'bee-a' ? 'Demo repository' : 'Other Host repo',
    )
    expect(header?.textContent).not.toContain('0000000000000001')
    expect(header?.textContent).not.toContain('other-repository-id')
  }
})
