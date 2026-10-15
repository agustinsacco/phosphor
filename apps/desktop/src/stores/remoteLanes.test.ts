import { beforeEach, expect, it, vi } from 'vitest'
import type { HostAttention } from '@shared/ipc'
import type { SessionPush } from '@shared/models'
import type { RpcCommand } from '@shared/rpc'
import { parseHostFrame } from '@shared/host-protocol'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from './sessions'
import { useArtifactsStore } from './artifacts'
import { useChatStore } from './chat'
import { useLayoutStore } from './layout'
import { useWorkspacesStore } from './workspaces'
import { useExtensionUiStore } from './extensionUi'
import { useLaneRevealStore } from '@/features/sessions/laneReveal'
import {
  attachRemoteLanesListener,
  canControlSession,
  openRemoteLane,
  navigateToLane,
  alignLaneMachineFilter,
  useRemoteLanesStore,
} from './remoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let push: ((push: SessionPush) => void) | undefined
let text = 'First history'
const invoke = vi.fn()
beforeEach(() => {
  text = 'First history'
  push = undefined
  invoke
    .mockReset()
    .mockImplementation(async (channel) =>
      channel === 'artifacts:forSession' ? [] : mockRemoteInfo,
    )
  useSessionsStore.setState({ live: {}, activeSessionId: null, navSeq: 0, gitByCwd: {} })
  useWorkspacesStore.setState({ recents: [] })
  useChatStore.setState({ sessions: {} })
  useLayoutStore.setState({ page: 'skills' })
  useExtensionUiStore.setState({ toasts: [] })
  useLaneRevealStore.setState({ seq: 0, groupKey: null })
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('artifacts.read')
  useRemoteLanesStore.setState({ hosts, filter: 'all' })
  useArtifactsStore.setState({ bySession: {} })
  vi.stubGlobal('window', {
    phosphor: {
      invoke,
      onSessionPush: (_id: string, listener: (push: SessionPush) => void) => {
        push = listener
        return () => {}
      },
      piCommand: vi.fn(async (_id: string, command: RpcCommand) => {
        if (command.type === 'get_messages')
          return {
            success: true,
            data: { messages: [{ role: 'user', content: text, timestamp: 0 }] },
          }
        if (command.type === 'get_state')
          return {
            success: true,
            data: { sessionFile: '/host/private.jsonl', sessionName: 'Remote' },
          }
        return { success: false }
      }),
    },
  })
})

it('adopts a remote handle through existing hydration without persisting Host paths', async () => {
  expect(await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')).toBe(true)
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
  expect(useSessionsStore.getState().live[mockRemoteInfo.sessionId]?.diskPath).toBeUndefined()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'hosts:openLane',
    'hosts:markRead',
    'artifacts:forSession',
  ])
  expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.items).toMatchObject([
    { kind: 'user', text },
  ])
})

it('resync replaces history using existing hydration', async () => {
  await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
  text = 'Replacement history'
  push?.({ kind: 'resync' })
  await vi.waitFor(() =>
    expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.items).toMatchObject([
      { kind: 'user', text: 'Replacement history' },
    ]),
  )
  expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.items).toHaveLength(1)
})

it('fails closed for viewers, offline Hosts and missing capabilities', async () => {
  await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
  expect(canControlSession(mockRemoteInfo.sessionId)).toBe(false)
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]
  if (!host?.lanes[0]?.control.controller) throw new Error('fixture')
  host.lanes[0].control.controller.self = true
  useRemoteLanesStore.setState({ hosts })
  expect(canControlSession(mockRemoteInfo.sessionId)).toBe(true)
  host.state = 'reconnecting'
  expect(canControlSession(mockRemoteInfo.sessionId)).toBe(false)
  host.state = 'ready'
  host.capabilities = ['sessions.read']
  expect(canControlSession(mockRemoteInfo.sessionId)).toBe(false)
  expect(canControlSession('local')).toBe(true)
})

it('never accepts resync from the Host wire', () => {
  expect(
    parseHostFrame(
      JSON.stringify({
        type: 'event',
        id: 'lane',
        laneId: mockRemoteInfo.laneId,
        cursor: { epoch: '0000000000000001', seq: 1 },
        event: { kind: 'pi', push: { kind: 'resync' } },
      }),
    ).ok,
  ).toBe(false)
})

it('reports remote focus and clears it for local navigation', async () => {
  const noop = () => () => undefined
  const phosphor = window.phosphor
  vi.stubGlobal('window', {
    phosphor: { ...phosphor, onHostsChanged: noop, onHostAttention: noop, onHostOpenLane: noop },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', { hasFocus: () => false })
  invoke.mockImplementation(async (channel: string) =>
    channel === 'hosts:snapshot' ? mockRemoteHosts : undefined,
  )
  const detach = attachRemoteLanesListener()
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
    activeSessionId: mockRemoteInfo.sessionId,
  })
  expect(invoke).toHaveBeenCalledWith('hosts:setFocusedLane', {
    hostId: MOCK_HOST_ID,
    laneId: mockRemoteInfo.laneId,
  })
  useSessionsStore.setState({ activeSessionId: null })
  expect(invoke).toHaveBeenLastCalledWith('hosts:setFocusedLane', null)
  detach()
  await Promise.resolve()
  expect(useRemoteLanesStore.getState().hosts).toEqual({})
})

it.each(['close', 'lane-removal', 'machine-removal'] as const)(
  'releases remote draft document bytes on %s',
  async (reason) => {
    const { useDraftsStore } = await import('./drafts')
    const { hostResourceKey } = await import('@shared/remote-host')
    const key = hostResourceKey(
      { kind: 'remote', hostId: MOCK_HOST_ID },
      'session',
      mockRemoteInfo.laneId ?? '',
    )
    useDraftsStore.setState({ drafts: {} })
    useDraftsStore.getState().patch(key, {
      text: 'keep text',
      attachments: [{ kind: 'file', path: '', name: 'a.pdf', size: 3, data: 'YWJj' }],
    })
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: {
          phosphorId: mockRemoteInfo.sessionId,
          workspacePath: mockRemoteInfo.workspacePath,
          target: mockRemoteInfo.target,
          laneId: mockRemoteInfo.laneId,
        },
      },
    })
    if (reason === 'close')
      await useSessionsStore.getState().disposeSession(mockRemoteInfo.sessionId)
    else {
      const hosts = structuredClone(mockRemoteHosts)
      if (reason === 'machine-removal') delete hosts[MOCK_HOST_ID]
      else if (hosts[MOCK_HOST_ID]) hosts[MOCK_HOST_ID].lanes = []
      const noop = () => () => undefined
      vi.stubGlobal('window', {
        phosphor: {
          ...window.phosphor,
          onHostsChanged: noop,
          onHostAttention: noop,
          onHostOpenLane: noop,
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
      vi.stubGlobal('document', { hasFocus: () => false })
      invoke.mockImplementation(async (channel: string) =>
        channel === 'hosts:snapshot' ? hosts : undefined,
      )
      const detach = attachRemoteLanesListener()
      await vi.waitFor(() => expect(useDraftsStore.getState().get(key).attachments).toEqual([]))
      detach()
    }
    expect(useDraftsStore.getState().get(key)).toMatchObject({ text: 'keep text', attachments: [] })
    useDraftsStore.getState().clear(key)
  },
)

it('hydrates on open and replaces artifacts after an artifact tool ends, including empty replies', async () => {
  const snapshot = {
    id: 'card',
    title: 'Host card',
    type: 'html',
    versions: [{ version: 1, title: 'Host card', content: '<h1>Host</h1>', createdAt: 1 }],
  }
  invoke.mockImplementation(async (channel) =>
    channel === 'artifacts:forSession' ? [snapshot] : mockRemoteInfo,
  )
  await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
  expect(useArtifactsStore.getState().bySession[mockRemoteInfo.sessionId]?.card?.title).toBe(
    'Host card',
  )
  invoke.mockImplementation(async () => [])
  push?.({
    kind: 'event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'call',
      toolName: 'artifact_update',
      result: { content: [] },
      isError: false,
    },
  })
  await vi.waitFor(() =>
    expect(useArtifactsStore.getState().bySession[mockRemoteInfo.sessionId]).toEqual({}),
  )
})

it.each(['reconnect', 'epoch'] as const)(
  'refreshes authoritative artifacts after %s',
  async (change) => {
    await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
    let changed: (() => void) | undefined
    const noop = () => () => undefined
    const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
    vi.stubGlobal('window', {
      phosphor: {
        ...window.phosphor,
        onHostsChanged: (listener: () => void) => {
          changed = listener
          return () => {}
        },
        onHostAttention: noop,
        onHostOpenLane: noop,
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('document', { hasFocus: () => false })
    invoke.mockImplementation(async (channel) =>
      channel === 'hosts:snapshot' ? structuredClone(hosts) : [],
    )
    const detach = attachRemoteLanesListener()
    try {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('hosts:snapshot'))
      invoke.mockClear()
      if (change === 'reconnect') hosts[MOCK_HOST_ID]!.connectionToken = 'new-connection'
      else hosts[MOCK_HOST_ID]!.cursor = { epoch: 'aaaaaaaaaaaaaaaa', seq: 0 }
      changed?.()
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('artifacts:forSession', mockRemoteInfo.sessionId),
      )
    } finally {
      detach()
    }
  },
)

it.each(['local', 'all'])(
  'navigates from %s to the Host, closes the page and reveals its group',
  async (filter) => {
    useRemoteLanesStore.setState({ filter })
    await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
    expect(useRemoteLanesStore.getState().filter).toBe(filter === 'all' ? 'all' : MOCK_HOST_ID)
    expect(useLayoutStore.getState().page).toBeNull()
    expect(useLaneRevealStore.getState().groupKey).toBe(
      `host:${MOCK_HOST_ID}:${mockRemoteHosts[MOCK_HOST_ID]?.lanes[0]?.repositoryId}`,
    )
  },
)

it('Mac row and notice navigation restores This Mac and closes a global page', async () => {
  useSessionsStore.setState({ live: { mac: { phosphorId: 'mac', workspacePath: '/mac' } } })
  useRemoteLanesStore.setState({ filter: MOCK_HOST_ID })
  expect(await navigateToLane({ sessionId: 'mac' })).toBe(true)
  expect(useRemoteLanesStore.getState().filter).toBe('local')
  expect(useSessionsStore.getState().activeSessionId).toBe('mac')
  expect(useLayoutStore.getState().page).toBeNull()
  expect(useLaneRevealStore.getState().groupKey).toBe('/mac')
})

it.each(['offline', 'removed'])(
  'keeps the current destination and reports one notice when %s',
  async (problem) => {
    const hosts = structuredClone(mockRemoteHosts)
    const host = hosts[MOCK_HOST_ID]
    if (!host) throw new Error('fixture')
    if (problem === 'offline') host.state = 'reconnecting'
    else host.lanes = []
    useRemoteLanesStore.setState({ hosts, filter: 'local' })
    useSessionsStore.setState({ activeSessionId: 'mac' })
    expect(await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')).toBe(false)
    expect(useRemoteLanesStore.getState().filter).toBe('local')
    expect(useSessionsStore.getState().activeSessionId).toBe('mac')
    expect(useLayoutStore.getState().page).toBe('skills')
    expect(useLaneRevealStore.getState().seq).toBe(0)
    expect(invoke).not.toHaveBeenCalledWith('hosts:openLane', MOCK_HOST_ID, mockRemoteInfo.laneId)
    expect(useExtensionUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      problem === 'offline'
        ? `${MOCK_HOST_ID} is offline`
        : `This lane was removed on ${MOCK_HOST_ID}`,
    ])
  },
)

it.each(['session', 'page', 'filter'])(
  'a newer %s navigation wins a slow open',
  async (navigation) => {
    let finish: ((info: typeof mockRemoteInfo) => void) | undefined
    invoke.mockImplementation((channel) =>
      channel === 'hosts:openLane'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve([]),
    )
    useRemoteLanesStore.setState({ filter: 'local' })
    const opening = openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
    if (navigation === 'session') useSessionsStore.getState().activate(null)
    if (navigation !== 'filter') useLayoutStore.getState().setPage('routines')
    else useRemoteLanesStore.getState().setFilter('all')
    finish?.(mockRemoteInfo)
    expect(await opening).toBe(false)
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
    expect(useRemoteLanesStore.getState().filter).toBe(navigation === 'filter' ? 'all' : 'local')
    expect(useLayoutStore.getState().page).toBe(navigation === 'filter' ? 'skills' : 'routines')
    expect(useLaneRevealStore.getState().seq).toBe(0)
  },
)

it('adopted lanes receive one settled card, not a second Host attention card', async () => {
  await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
  let attention: ((event: HostAttention) => void) | undefined
  const noop = () => () => undefined
  vi.stubGlobal('window', {
    phosphor: {
      ...window.phosphor,
      onHostsChanged: noop,
      onHostOpenLane: noop,
      onHostAttention: (listener: typeof attention) => {
        attention = listener
        return () => {}
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', { hasFocus: () => false })
  invoke.mockImplementation(async (channel) =>
    channel === 'hosts:snapshot' ? mockRemoteHosts : [],
  )
  const detach = attachRemoteLanesListener()
  const { noticeLaneSettled } = await import('@/features/sessions/laneNotices')
  useLayoutStore.getState().setPage('skills')
  const notify = vi.spyOn(useExtensionUiStore.getState(), 'notify')
  noticeLaneSettled(mockRemoteInfo.sessionId)
  attention?.({
    hostId: MOCK_HOST_ID,
    laneId: mockRemoteInfo.laneId ?? '',
    kind: 'finished',
    title: 'Remote',
    at: '2026-01-01T00:00:00Z',
  })
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
  expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  invoke.mockImplementation(async (channel) =>
    channel === 'hosts:snapshot'
      ? mockRemoteHosts
      : channel === 'artifacts:forSession'
        ? []
        : mockRemoteInfo,
  )
  expect(await useExtensionUiStore.getState().toasts[0]?.onOpen?.()).toBe(true)
  notify.mockRestore()
  detach()
})

it.each(['offline', 'removed'])(
  'does not commit when a lane becomes %s during open',
  async (problem) => {
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
    expect(useRemoteLanesStore.getState().filter).toBe('local')
    expect(useLayoutStore.getState().page).toBe('skills')
    expect(useLaneRevealStore.getState().seq).toBe(0)
    expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  },
)

it('classifies an open rejection from a fresh snapshot without showing Host error payloads', async () => {
  invoke.mockImplementation(async (channel) => {
    if (channel === 'hosts:openLane') throw new Error('private Host error payload')
    const hosts = structuredClone(mockRemoteHosts)
    const host = hosts[MOCK_HOST_ID]
    if (host) host.lanes = []
    return hosts
  })
  expect(await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')).toBe(false)
  expect(useExtensionUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
    `This lane was removed on ${MOCK_HOST_ID}`,
  ])
})

it('OS open requests use the same window-local navigation', async () => {
  let open: ((target: { hostId: string; laneId: string }) => void) | undefined
  const noop = () => () => undefined
  vi.stubGlobal('window', {
    phosphor: {
      ...window.phosphor,
      onHostsChanged: noop,
      onHostAttention: noop,
      onHostOpenLane: (listener: typeof open) => {
        open = listener
        return () => {}
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', { hasFocus: () => false })
  invoke.mockImplementation(async (channel) =>
    channel === 'hosts:snapshot'
      ? mockRemoteHosts
      : channel === 'artifacts:forSession'
        ? []
        : mockRemoteInfo,
  )
  useRemoteLanesStore.setState({ filter: 'local' })
  const detach = attachRemoteLanesListener()
  open?.({ hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId ?? '' })
  await vi.waitFor(() =>
    expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId),
  )
  expect(useRemoteLanesStore.getState().filter).toBe(MOCK_HOST_ID)
  expect(useLayoutStore.getState().page).toBeNull()
  detach()
})

it.each(['local', 'all', MOCK_HOST_ID])(
  'aligns a Mac row filter from %s without changing matching/all filters',
  (filter) => {
    useRemoteLanesStore.setState({ filter })
    alignLaneMachineFilter('local')
    expect(useRemoteLanesStore.getState().filter).toBe(filter === 'all' ? 'all' : 'local')
  },
)

it('returns false after an unclassified bridge failure and emits one fixed notice', async () => {
  invoke.mockRejectedValue(new Error('private payload'))
  expect(await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')).toBe(false)
  expect(useExtensionUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
    'Could not open the remote lane.',
  ])
})

it('local notice callbacks expose the navigation result for receipt actions', async () => {
  const { notifyLane } = await import('@/features/sessions/laneNotices')
  useSessionsStore.setState({ live: { mac: { phosphorId: 'mac', workspacePath: '/mac' } } })
  notifyLane('mac', { message: 'Finished' })
  const notice = useExtensionUiStore.getState().toasts[0]
  expect(await notice?.onOpen?.()).toBe(true)
})

it.each([true, false])(
  'reveals the sidebar representative for a worktree with known main repo: %s',
  async (knownMain) => {
    const workspacePath = '/linked/worktree'
    useWorkspacesStore.setState({
      recents: [
        { path: workspacePath, name: 'Worktree', lastOpenedAt: 0 },
        ...(knownMain ? [{ path: '/repo', name: 'Repo', lastOpenedAt: 0 }] : []),
      ],
    })
    useSessionsStore.setState({
      live: { worktree: { phosphorId: 'worktree', workspacePath } },
      gitByCwd: {
        [workspacePath]: { isRepo: true, branch: 'task', isWorktree: true, mainRepoPath: '/repo' },
      },
    })
    expect(await navigateToLane({ sessionId: 'worktree' })).toBe(true)
    expect(useLaneRevealStore.getState().groupKey).toBe(knownMain ? '/repo' : workspacePath)
  },
)
