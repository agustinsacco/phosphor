// @vitest-environment jsdom
import { useMachinesStore } from '@/stores/machines'
import { MACHINE } from '@/features/machines/__fixtures__/control'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useBrowserNavigation } from './useBrowserNavigation'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
import { mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { clearBrowserMemory, useBrowserMemory } from './browserMemory'
import { useLaneCreatesStore } from '@/stores/laneCreates'

function Harness() {
  const navigation = useBrowserNavigation()
  return <p>{navigation.pending ? 'pending' : navigation.location.to}</p>
}
const roots: Root[] = []
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useMachinesStore.setState({ remoteEnabled: false })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('projects legacy lane activation to a single deep link and clears browser focus without native persistence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ remoteEnabled: false })
  const invoke = vi.fn(async (_channel: string) => undefined)
  vi.stubGlobal('phosphor', { invoke })
  useSessionsStore.setState({
    activeSessionId: null,
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
  })
  useLayoutStore.setState({ page: null })
  useRemoteLanesStore.setState({ filter: 'local' })
  window.history.replaceState(null, '', '/pages/machines')
  const push = vi.spyOn(window.history, 'pushState')
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<Harness />))
  expect(container.textContent).toBe('pending')
  await act(async () => useMachinesStore.setState({ remoteEnabled: true }))
  expect(container.textContent).toBe('page')
  await act(async () => useSessionsStore.getState().activate(mockRemoteInfo.sessionId))
  expect(window.location.pathname).toBe(`/lanes/${MOCK_HOST_ID}/${mockRemoteInfo.laneId}/chat`)
  expect(push).toHaveBeenCalledTimes(1)
  await act(async () => {
    window.history.replaceState(null, '', '/lanes')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(useSessionsStore.getState().activeSessionId).toBeNull()
  expect(invoke.mock.calls.every((call) => !String(call[0]).startsWith('app:'))).toBe(true)
})
it.each([1, 2])(
  'pins the scoped creation target without adding history: %i Hosts',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
    const machines = [MACHINE, { ...MACHINE, id: 'other-host' }].slice(0, count)
    useMachinesStore.setState({ machines, remoteEnabled: true, loading: false, error: null })
    useRemoteLanesStore.setState({
      filter: 'all',
      hosts: Object.fromEntries(
        machines.map((machine) => [
          machine.id,
          {
            state: 'ready',
            connectionToken: 'test',
            capabilities: ['sessions.control'],
            repositories: [],
            lanes: [],
          },
        ]),
      ),
    })
    useLayoutStore.setState({ page: null })
    window.history.replaceState(null, '', '/new')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    await act(async () => root.render(<Harness />))
    // New always opens somewhere: with no machine in view, the first that can start a lane.
    expect(window.location.pathname).toBe(`/new/${MACHINE.id}`)
    expect(push).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
    await act(async () => useMachinesStore.setState({ machines: [] }))
    expect(window.location.pathname).toBe(`/new/${MACHINE.id}`)
  },
)

it('waits for machine scope before mounting a page and puts feature machine changes in the URL', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ remoteEnabled: true })
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
  useSessionsStore.setState({ activeSessionId: null })
  useRemoteLanesStore.setState({ filter: 'local' })
  useLayoutStore.setState({ page: null })
  window.history.replaceState(null, '', '/pages/skills/host-one')
  const observations: string[] = []
  function Page() {
    const navigation = useBrowserNavigation()
    if (!navigation.pending) observations.push(useRemoteLanesStore.getState().filter)
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(<Page />))
  expect(observations.length).toBeGreaterThan(0)
  expect(observations.every((machine) => machine === 'host-one')).toBe(true)
  await act(async () => useMachinePagesStore.setState({ skillsMachine: 'host-two' }))
  expect(window.location.pathname).toBe('/pages/skills/host-two')
  expect(useRemoteLanesStore.getState().filter).toBe('host-two')
})

it('New and Skills open on the machine last looked at, not the first one', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
  const machines = [MACHINE, { ...MACHINE, id: 'other-host' }]
  const ready = {
    state: 'ready' as const,
    connectionToken: 'test',
    capabilities: ['sessions.control' as const],
    repositories: [],
    lanes: [],
  }
  useMachinesStore.setState({ machines, remoteEnabled: true, loading: false, error: null })
  useRemoteLanesStore.setState({
    filter: 'all',
    hosts: { [MACHINE.id]: ready, 'other-host': ready } as never,
  })
  useBrowserMemory.setState({ lastMachine: 'other-host' })
  useLayoutStore.setState({ page: null })
  window.history.replaceState(null, '', '/new')
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(<Harness />))
  expect(window.location.pathname).toBe('/new/other-host')
  clearBrowserMemory()
})

it('a placeholder recovered into its lane replaces the placeholder URL', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
  useMachinesStore.setState({ remoteEnabled: true })
  useLayoutStore.setState({ page: null })
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
  window.history.replaceState(null, '', `/new/${MOCK_HOST_ID}/create-9`)
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<Harness />))
  const push = vi.spyOn(window.history, 'pushState')
  const lane = { hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! }
  await act(async () => {
    useSessionsStore
      .getState()
      .beginOpening({ workspacePath: 'x', title: 't', reason: 'open', lane })
  })
  expect(window.location.pathname).toBe(`/lanes/${MOCK_HOST_ID}/${lane.laneId}/chat`)
  expect(push).not.toHaveBeenCalled()
})

it('opening another lane from a live placeholder keeps the placeholder in history', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
  useMachinesStore.setState({ remoteEnabled: true })
  useLayoutStore.setState({ page: null })
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
  const live = { id: 'create-live', hostId: MOCK_HOST_ID, repositoryId: 'r', title: 't' }
  useLaneCreatesStore.setState({
    creates: { [live.id]: { ...live, text: '', attachments: [], branches: [], seen: [] } as never },
  })
  window.history.replaceState(null, '', `/new/${MOCK_HOST_ID}/${live.id}`)
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(<Harness />))
  const push = vi.spyOn(window.history, 'pushState')
  const lane = { hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! }
  await act(async () => {
    useSessionsStore
      .getState()
      .beginOpening({ workspacePath: 'x', title: 't', reason: 'open', lane })
  })
  expect(window.location.pathname).toBe(`/lanes/${MOCK_HOST_ID}/${lane.laneId}/chat`)
  expect(push).toHaveBeenCalled()
  useLaneCreatesStore.setState({ creates: {} })
})
