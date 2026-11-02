// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationProvider } from '@/navigation/Navigation'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { MACHINE } from './__fixtures__/control'
import { MachineList } from './MachineList'

let root: Root
let container: HTMLDivElement
const navigate = vi.fn()
const machine = { ...MACHINE, id: MOCK_HOST_ID, lastSeenAt: new Date().toISOString() }

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => null), platform: 'darwin' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  useChatStore.setState({ sessions: {} })
  vi.unstubAllGlobals()
  navigate.mockReset()
})

const render = (): void =>
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'page', page: 'machines' }, navigate }}>
        <MachineList
          computer={{ error: false }}
          signedIn
          machines={[machine]}
          loading={false}
          now={Date.now()}
          offset={0}
          onOpen={() => undefined}
          empty={null}
        />
      </NavigationProvider>,
    ),
  )
const tasks = (): string[] =>
  [...container.querySelectorAll('[data-task-state]')].map((el) => el.textContent ?? '')

it("lists a Host's running lanes under its row and opens one", () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const lane = host.lanes[0]!
  host.lanes = [
    { ...lane, laneId: 'l1', title: 'Fix login', branch: 'agustin/login', activity: 'working' },
    { ...lane, laneId: 'l2', title: 'Ask me', activity: 'needs-input' },
    { ...lane, laneId: 'l3', title: 'Done', activity: 'idle' },
  ]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  render()
  expect(tasks()).toEqual(['Ask meNeeds input', 'Fix loginagustin/loginWorking'])
  const row = container.querySelector('[data-testid=enrolled-machine-row]')?.textContent
  expect(row).toContain('1 running · 1 needs you')
  act(() => container.querySelector<HTMLButtonElement>('[data-task-state=working]')?.click())
  expect(navigate).toHaveBeenCalledWith({
    to: 'lane',
    lane: { hostId: MOCK_HOST_ID, laneId: 'l1' },
  })
})

it('caps the list and links the rest to the machine lanes', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const lane = host.lanes[0]!
  host.lanes = [1, 2, 3, 4, 5].map((n) => ({ ...lane, laneId: `l${n}`, activity: 'working' }))
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  render()
  expect(tasks()).toHaveLength(3)
  const more = [...container.querySelectorAll('button')].find((b) => b.textContent === '2 more →')
  act(() => more?.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'lanes', machine: MOCK_HOST_ID })
})

it("lists this computer's streaming and asking sessions, not idle ones", () => {
  const live = (id: string) => ({ phosphorId: id, workspacePath: '/w' })
  useSessionsStore.setState({ live: { a: live('a'), b: live('b'), c: live('c') } })
  const chat = useChatStore.getState().sessions
  useChatStore.setState({
    sessions: {
      ...chat,
      a: {
        ...(chat.a ?? ({} as never)),
        isStreaming: true,
        items: [{ id: 'u', kind: 'user', text: 'Write the tests' }],
        meta: null,
      } as never,
      b: { isStreaming: false, items: [], meta: null } as never,
      c: { isStreaming: false, items: [], meta: { sessionName: 'Pick one' } } as never,
    },
  })
  useExtensionUiStore.setState({ dialogs: [{ sessionId: 'c' }] as never })
  try {
    render()
    expect(tasks()).toEqual(['Pick oneNeeds input', 'Write the testsWorking'])
    act(() => container.querySelector<HTMLButtonElement>('[data-task-state=working]')?.click())
    expect(navigate).toHaveBeenCalledWith({ to: 'lane', lane: { sessionId: 'a' } })
  } finally {
    useExtensionUiStore.setState({ dialogs: [] })
  }
})
