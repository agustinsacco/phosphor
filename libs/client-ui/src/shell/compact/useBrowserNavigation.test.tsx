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
  'pins only an unambiguous ready creation target without adding history: %i Hosts',
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
    expect(window.location.pathname).toBe(count === 1 ? `/new/${MACHINE.id}` : '/new')
    expect(push).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(count === 1 ? 1 : 0)
    if (count === 1) {
      await act(async () => useMachinesStore.setState({ machines: [] }))
      expect(window.location.pathname).toBe(`/new/${MACHINE.id}`)
    }
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
