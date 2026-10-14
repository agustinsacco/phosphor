import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionPush } from '@shared/models'
import type { RpcCommand } from '@shared/rpc'
import { parseHostFrame } from '@shared/host-protocol'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from './sessions'
import { useChatStore } from './chat'
import {
  attachRemoteLanesListener,
  canControlSession,
  openRemoteLane,
  useRemoteLanesStore,
} from './remoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let push: ((push: SessionPush) => void) | undefined
let text = 'First history'
const invoke = vi.fn()
beforeEach(() => {
  text = 'First history'
  push = undefined
  invoke.mockReset().mockResolvedValue(mockRemoteInfo)
  useSessionsStore.setState({ live: {}, activeSessionId: null, navSeq: 0 })
  useChatStore.setState({ sessions: {} })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'all' })
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
  await openRemoteLane(MOCK_HOST_ID, mockRemoteInfo.laneId ?? '')
  expect(useSessionsStore.getState().activeSessionId).toBe(mockRemoteInfo.sessionId)
  expect(useSessionsStore.getState().live[mockRemoteInfo.sessionId]?.diskPath).toBeUndefined()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'hosts:openLane',
    'hosts:markRead',
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
