import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionPush } from '@shared/models'
import type { RpcCommand } from '@shared/rpc'
import type { LiveSessionInfo } from '@shared/models'
import { remoteLaneKey } from '@shared/remote-host'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from './sessions'
import { bindHostsSnapshotRead } from './hostsSnapshotRead'
import { useChatStore } from './chat'
import { useLayoutStore } from './layout'
import { useExtensionUiStore } from './extensionUi'
import { useLaneRevealStore } from '@/features/sessions/laneReveal'
import { navigateToLane, openRemoteLane, useRemoteLanesStore } from './remoteLanes'

vi.mock('@/lib/monaco', () => ({}))

const LANE = mockRemoteInfo.laneId ?? ''
const invoke = vi.fn()
/** Each `hosts:openLane` call, held until the test settles it. */
let opens: { resolve: (info: LiveSessionInfo) => void; reject: (error: Error) => void }[] = []

beforeEach(() => {
  opens = []
  invoke
    .mockReset()
    .mockImplementation((channel: string) =>
      channel === 'hosts:openLane'
        ? new Promise((resolve, reject) => opens.push({ resolve, reject }))
        : channel === 'hosts:snapshot'
          ? Promise.resolve(structuredClone(mockRemoteHosts))
          : Promise.resolve([]),
    )
  useSessionsStore.setState({
    live: { mac: { phosphorId: 'mac', workspacePath: '/mac' } },
    activeSessionId: 'mac',
    navSeq: 0,
    opening: null,
    gitByCwd: {},
  })
  useChatStore.setState({ sessions: {} })
  useLayoutStore.setState({ page: 'skills' })
  useExtensionUiStore.setState({ toasts: [] })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'local' })
  vi.stubGlobal('window', {
    phosphor: {
      invoke,
      onSessionPush: (_id: string, _listener: (push: SessionPush) => void) => () => {},
      piCommand: vi.fn(async (_id: string, command: RpcCommand) =>
        command.type === 'get_messages'
          ? { success: true, data: { messages: [] } }
          : { success: false },
      ),
    },
  })
})

const openCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'hosts:openLane')
const toasts = () => useExtensionUiStore.getState().toasts.map((toast) => toast.message)

it('switches to the clicked Host lane at once and activates it when the open lands', async () => {
  const opened = openRemoteLane(MOCK_HOST_ID, LANE)
  // Same tick as the click: the lane is the selection and the main view says it is opening.
  expect(useSessionsStore.getState().opening).toMatchObject({
    lane: { hostId: MOCK_HOST_ID, laneId: LANE },
    workspacePath: remoteLaneKey(MOCK_HOST_ID, LANE),
    reason: 'open',
  })
  expect(useLayoutStore.getState().page).toBeNull()
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(useSessionsStore.getState().activeSessionId).toBe('mac')
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  opens[0]!.resolve(mockRemoteInfo)
  expect(await opened).toBe(true)
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
  expect(useSessionsStore.getState().opening).toBeNull()
})

it.each(['lane', 'new', 'page'])(
  'a %s click switches at once; the earlier open lands quietly without taking focus',
  async (next) => {
    const opened = openRemoteLane(MOCK_HOST_ID, LANE)
    await vi.waitFor(() => expect(opens).toHaveLength(1))
    if (next === 'lane') useSessionsStore.getState().activate('mac')
    if (next === 'new') useSessionsStore.getState().activate(null)
    if (next === 'page') useLayoutStore.getState().setPage('routines')
    expect(useSessionsStore.getState().opening).toBeNull()
    opens[0]!.resolve(mockRemoteInfo)
    expect(await opened).toBe(false)
    expect(useSessionsStore.getState().activeSessionId).toBe(
      next === 'lane' ? 'mac' : next === 'new' ? null : 'mac',
    )
    expect(useLayoutStore.getState().page).toBe(next === 'page' ? 'routines' : null)
    // Adopted anyway, so going back to it is instant.
    expect(useSessionsStore.getState().live[mockRemoteInfo.sessionId]).toBeDefined()
    expect(toasts()).toEqual([])
  },
)

it('clicking back to a lane whose open is in flight shows it opening and reuses that open', async () => {
  const first = openRemoteLane(MOCK_HOST_ID, LANE)
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  useSessionsStore.getState().activate('mac')
  const second = navigateToLane({ hostId: MOCK_HOST_ID, laneId: LANE })
  expect(useSessionsStore.getState().opening).toMatchObject({
    lane: { hostId: MOCK_HOST_ID, laneId: LANE },
  })
  opens[0]!.resolve(mockRemoteInfo)
  expect(await second).toBe(true)
  expect(await first).toBe(false)
  expect(openCalls()).toHaveLength(1)
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
})

it('a failed open stays in its lane view with the reason, and Retry opens it again', async () => {
  const opened = openRemoteLane(MOCK_HOST_ID, LANE)
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  opens[0]!.reject(new Error('private Host payload'))
  expect(await opened).toBe(false)
  expect(useSessionsStore.getState().opening).toMatchObject({
    lane: { hostId: MOCK_HOST_ID, laneId: LANE },
    failure: 'Could not open the remote lane.',
  })
  expect(useSessionsStore.getState().activeSessionId).toBe('mac')
  expect(toasts()).toEqual(['Could not open the remote lane.'])
  const retried = openRemoteLane(MOCK_HOST_ID, LANE)
  expect(useSessionsStore.getState().opening?.failure).toBeUndefined()
  await vi.waitFor(() => expect(opens).toHaveLength(2))
  opens[1]!.resolve(mockRemoteInfo)
  expect(await retried).toBe(true)
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
})

it('an open that fails while you are elsewhere says nothing, and the next click starts afresh', async () => {
  const opened = openRemoteLane(MOCK_HOST_ID, LANE)
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  useSessionsStore.getState().activate('mac')
  opens[0]!.reject(new Error('down'))
  expect(await opened).toBe(false)
  expect(toasts()).toEqual([])
  expect(useSessionsStore.getState().opening).toBeNull()
  const again = openRemoteLane(MOCK_HOST_ID, LANE)
  expect(useSessionsStore.getState().opening?.failure).toBeUndefined()
  await vi.waitFor(() => expect(opens).toHaveLength(2))
  opens[1]!.resolve(mockRemoteInfo)
  expect(await again).toBe(true)
})

it('switches to a lane this client already holds without the opening view', async () => {
  const opened = openRemoteLane(MOCK_HOST_ID, LANE)
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  opens[0]!.resolve(mockRemoteInfo)
  expect(await opened).toBe(true)
  useSessionsStore.getState().activate('mac')
  const back = openRemoteLane(MOCK_HOST_ID, LANE)
  expect(useSessionsStore.getState().opening).toBeNull()
  await vi.waitFor(() => expect(opens).toHaveLength(2))
  opens[1]!.resolve(mockRemoteInfo)
  expect(await back).toBe(true)
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
})

it.each(['offline', 'removed'])(
  'does not commit when a lane becomes %s during open',
  async (problem) => {
    useLaneRevealStore.setState({ seq: 0, groupKey: null })
    useRemoteLanesStore.setState({ filter: 'local' })
    useSessionsStore.setState({ activeSessionId: 'mac' })
    invoke.mockImplementation(async (channel) => {
      if (channel !== 'hosts:openLane') return []
      const hosts = structuredClone(mockRemoteHosts)
      const host = hosts[MOCK_HOST_ID]
      if (!host) throw new Error('fixture')
      if (problem === 'offline') host.state = 'reconnecting'
      else host.lanes = []
      useRemoteLanesStore.setState({ hosts })
      return mockRemoteInfo
    })
    expect(await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')).toBe(false)
    expect(useSessionsStore.getState().activeSessionId).toBe('mac')
    // The click switched to the lane at once; its view now says why it did not open.
    expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
    expect(useLayoutStore.getState().page).toBeNull()
    expect(useSessionsStore.getState().opening?.failure).toBe(
      useExtensionUiStore.getState().toasts[0]?.message,
    )
    expect(useLaneRevealStore.getState().seq).toBe(0)
    expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  },
)

it.each(['page', 'machine'])('leaving a failed lane via %s clears its Retry view', async (via) => {
  const opened = openRemoteLane(MOCK_HOST_ID, LANE)
  opens[0]!.reject(new Error('down'))
  expect(await opened).toBe(false)
  expect(useSessionsStore.getState().opening?.failure).toBeDefined()
  if (via === 'page') {
    useLayoutStore.getState().setPage('routines')
    useLayoutStore.getState().setPage(null)
  } else useRemoteLanesStore.getState().setFilter('local')
  expect(useSessionsStore.getState().opening).toBeNull()
})

it('selects a rejoined lane until both bootstrap and the snapshot refresh finish', async () => {
  let finishBootstrap!: () => void
  const bootstrap = new Promise<void>((resolve) => (finishBootstrap = resolve))
  vi.mocked(window.phosphor.piCommand).mockImplementation(async (_id, command) => {
    if (command.type === 'get_state') await bootstrap
    return { type: 'response', command: command.type, success: false, error: 'not available' }
  })
  let finishSnapshot!: () => void
  const snapshot = new Promise<void>((resolve) => (finishSnapshot = resolve))
  const refresh = vi.fn(() => snapshot)
  bindHostsSnapshotRead(refresh)
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.warmOnOpen = true
  try {
    const first = openRemoteLane(MOCK_HOST_ID, LANE)
    opens[0]!.resolve(mockRemoteInfo)
    await vi.waitFor(() =>
      expect(window.phosphor.piCommand).toHaveBeenCalledWith(mockRemoteInfo.sessionId, {
        type: 'get_state',
      }),
    )
    expect(useSessionsStore.getState().live[mockRemoteInfo.sessionId]).toBeDefined()
    useSessionsStore.getState().activate('mac')
    const second = openRemoteLane(MOCK_HOST_ID, LANE)
    const duringBootstrap = useSessionsStore.getState().opening?.lane
    finishBootstrap()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const duringSnapshot = useSessionsStore.getState().opening?.lane
    expect(useSessionsStore.getState().activeSessionId).toBe('mac')
    finishSnapshot()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(openCalls()).toHaveLength(1)
    expect(duringBootstrap).toEqual({ hostId: MOCK_HOST_ID, laneId: LANE })
    expect(duringSnapshot).toEqual(duringBootstrap)
    expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
  } finally {
    bindHostsSnapshotRead(async () => undefined)
  }
})
