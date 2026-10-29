import { beforeEach, expect, it } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { TAKE_CONTROL_FIRST } from '@/features/sessions/remoteLaneActions'
import { currentSessionMenuItems, sessionMenuItems } from './sessionMenuItems'

const table = (items: ReturnType<typeof sessionMenuItems>) =>
  items.map(({ label, hint, disabled }) => [label, hint, !!disabled])

const SESSION = mockRemoteInfo.sessionId
function lane(change: (host: (typeof mockRemoteHosts)[string]) => void): void {
  const hosts = structuredClone(mockRemoteHosts)
  change(hosts[MOCK_HOST_ID]!)
  useRemoteLanesStore.setState({ hosts })
}

beforeEach(() => {
  useChatStore.setState({ sessions: {} })
  useSessionsStore.setState({
    live: {
      local: { phosphorId: 'local', workspacePath: '/w' },
      [SESSION]: { ...mockRemoteInfo, phosphorId: SESSION },
    },
  })
  lane(() => {})
})

it('lists every option enabled with its current value for a local session', () => {
  expect(table(currentSessionMenuItems('local'))).toEqual([
    ['Export HTML…', undefined, false],
    ['Compact now…', undefined, false],
    ['Auto-compaction', 'on', false],
    ['Auto-retry', 'on', false],
    ['Steering', 'all at once', false],
    ['Follow-ups', 'all at once', false],
  ])
})

it('shows the values pi reported', () => {
  const meta = {
    autoCompactionEnabled: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'all',
  } as Parameters<typeof sessionMenuItems>[0]['meta']
  const hints = sessionMenuItems({ sessionId: 'x', meta, remote: false, controlHint: undefined })
  expect(hints.map((item) => item.hint).slice(2)).toEqual([
    'off',
    'on',
    'one at a time',
    'all at once',
  ])
})

it('gives a Host lane controller the commands and keeps Export a This Mac action', () => {
  lane((host) => {
    host.lanes[0]!.control.controller = { label: 'This Desktop', connected: true, self: true }
  })
  expect(table(currentSessionMenuItems(SESSION))).toEqual([
    ['Export HTML…', REMOTE_UNAVAILABLE, true],
    ['Compact now…', undefined, false],
    ['Auto-compaction', 'on', false],
    ['Auto-retry', 'on', false],
    ['Steering', 'all at once', false],
    ['Follow-ups', 'all at once', false],
  ])
})

it('tells a Host lane reader to take control first', () => {
  const items = table(currentSessionMenuItems(SESSION))
  expect(items[0]).toEqual(['Export HTML…', REMOTE_UNAVAILABLE, true])
  for (const row of items.slice(1)) expect(row.slice(1)).toEqual([TAKE_CONTROL_FIRST, true])
})

it('says why when the Host is down or does not offer control', () => {
  lane((host) => {
    host.state = 'reconnecting'
    host.lanes[0]!.control.controller = { label: 'This Desktop', connected: true, self: true }
  })
  expect(currentSessionMenuItems(SESSION)[1]!.hint).toBe(REMOTE_NOT_READY)
  lane((host) => {
    host.capabilities = ['sessions.read']
  })
  expect(currentSessionMenuItems(SESSION)[1]!.hint).toBe(REMOTE_UNAVAILABLE)
})
