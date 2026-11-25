import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import { hostLaneSession, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore, type ChatSession } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { laneBusyNow } from './laneBusy'

const id = mockRemoteInfo.sessionId
const delegatedWidget = (state: string) => ({
  placement: 'aboveEditor' as const,
  lines: [
    'PI_SUBAGENT_ASYNC_JSON:' +
      JSON.stringify({
        kind: 'pi-subagents.async-status-snapshot',
        version: 1,
        runs: [{ id: 'run', label: 'Reviewer', state, children: [] }],
      }),
  ],
})

function chat(patch: Partial<ChatSession>) {
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, ...patch } },
  }))
}

function hostLane(activity: HostLaneView['activity']) {
  const { hosts, live } = hostLaneSession({ activity, self: true })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
}

beforeEach(() => {
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(id)
  useExtensionUiStore.setState({ widgets: {}, dialogs: [] })
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
})
afterEach(() => {
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
})

it('an idle lane, on This Mac or on a Host, is not busy', () => {
  expect(laneBusyNow(id)).toBe(false)
  hostLane('idle')
  expect(laneBusyNow(id)).toBe(false)
  hostLane('stopped')
  expect(laneBusyNow(id)).toBe(false)
})

it.each<[string, Partial<ChatSession>]>([
  ['a run', { isStreaming: true }],
  ['a compaction', { isCompacting: true }],
  ['a prompt pi has not answered', { promptSentAt: 1 }],
  ['a scheduled retry', { retry: { attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'x' } }],
  ['a queued follow-up', { queues: { steering: [], followUp: ['next'] } }],
  ['a queued steer', { queues: { steering: ['now'], followUp: [] } }],
])('the chat makes the lane busy during %s', (_, patch) => {
  chat(patch)
  expect(laneBusyNow(id)).toBe(true)
})

it.each(['working', 'needs-input'] as const)(
  'a Host lane is busy while its Host reports it %s, whatever the chat holds',
  (activity) => {
    hostLane(activity)
    expect(useChatStore.getState().sessions[id]?.isStreaming).toBe(false)
    expect(laneBusyNow(id)).toBe(true)
  },
)

it('background agents still running keep the lane busy after the parent run ends', () => {
  useExtensionUiStore.setState({
    widgets: { [id]: { 'subagent-async': delegatedWidget('running') } },
  })
  expect(laneBusyNow(id)).toBe(true)
  useExtensionUiStore.setState({
    widgets: { [id]: { 'subagent-async': delegatedWidget('complete') } },
  })
  expect(laneBusyNow(id)).toBe(false)
})

it('a question waiting for an answer keeps the lane busy', () => {
  useExtensionUiStore.setState({
    dialogs: [
      {
        sessionId: id,
        request: {
          type: 'extension_ui_request',
          id: 'q',
          method: 'confirm',
          title: 'Go?',
          message: '',
        },
      },
    ],
  })
  expect(laneBusyNow(id)).toBe(true)
})

it('a timed-out extension question no longer makes an idle Host lane busy', () => {
  vi.useFakeTimers()
  try {
    hostLane('idle')
    useExtensionUiStore.getState().handleRequest(id, {
      type: 'extension_ui_request',
      id: 'q',
      method: 'confirm',
      title: 'Go?',
      message: '',
      timeout: 100,
    })
    expect(laneBusyNow(id)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(laneBusyNow(id)).toBe(false)
    expect(useExtensionUiStore.getState().dialogs).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})
