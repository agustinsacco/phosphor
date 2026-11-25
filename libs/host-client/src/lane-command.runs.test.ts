import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaneActivity, LaneSnapshot, LaneSummary } from '@phosphor/shared/host-protocol'
import { laneCommand } from './lane-command'
import { flush, receive, type Connection, type Handle } from './lane-stream'
import { createLaneProjection } from './projection'

/*
 * A Host lane's state belongs to the pi process that reported it. Once the
 * lane stops and starts again, a state the previous process reported must
 * never be served as the new process's `get_state`, whatever query fails.
 */
const LANE = '11111111-1111-4111-8111-111111111111'
const call = vi.fn()
afterEach(() => call.mockReset())

const summary = (activity: LaneActivity): LaneSummary => ({
  laneId: LANE,
  repositoryId: '0123456789abcdef',
  cwd: '/repo',
  title: 'Lane',
  branch: null,
  worktree: false,
  model: null,
  activity,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
})
const state = (thinkingLevel: string) => ({
  thinkingLevel,
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionId: 'pi-session',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
})

function handle(): Handle {
  const h = {
    info: { sessionId: 'phosphor-session', workspacePath: '/repo', laneId: LANE },
    window: { id: 1, send: () => {}, destroyed: () => false },
    hostId: 'host',
    laneId: LANE,
    summary: summary('idle'),
    projection: createLaneProjection({ now: Date.now, overflow: () => {} }),
    connection: { call, snapshot: () => ({ lanes: [] }) } as unknown as Connection,
    changed: () => {},
    close: () => {},
    unwatch: () => {},
    ready: Promise.resolve(),
    resolve: () => {},
    reject: () => {},
    messageBytes: 0,
  }
  return h as unknown as Handle
}
function snapshot(h: Handle, activity: LaneActivity, piState: object | null) {
  const value = { summary: summary(activity), state: piState, messages: [], pending: [] }
  receive(h, {
    type: 'snapshot',
    snapshot: { ...value, dialogs: [], ui: [] } as unknown as LaneSnapshot,
  } as never)
  flush(h)
}
const event = (h: Handle, activity: LaneActivity) =>
  receive(h, { type: 'event', event: { kind: 'summary', summary: summary(activity) } } as never)
const ports = (h: Handle) => ({
  identity: { randomUUID: () => 'id', randomHex: () => 'hex' },
  connection: () => h.connection,
  label: () => 'Host',
  current: () => true,
})
const getState = (h: Handle) => laneCommand(h, { type: 'get_state' }, ports(h))

describe('get_state across a lane’s pi processes', () => {
  it('serves the last state within a run and while stopped, never a previous run’s', async () => {
    const h = handle()
    snapshot(h, 'idle', state('high'))
    call.mockRejectedValue(new Error('unavailable'))
    expect(await getState(h)).toMatchObject({ success: true, data: { thinkingLevel: 'high' } })

    event(h, 'stopped')
    call.mockResolvedValue({ type: 'result', id: 'r', ok: true, data: null })
    expect(await getState(h)).toMatchObject({ success: true, data: { thinkingLevel: 'high' } })

    // Resumed: the Host shows the lane running before the new pi's snapshot.
    event(h, 'idle')
    call.mockRejectedValue(new Error('unavailable'))
    expect(await getState(h)).toMatchObject({ success: false })
    call.mockResolvedValue({ type: 'result', id: 'r', ok: false, error: { message: 'x' } })
    expect(await getState(h)).toMatchObject({ success: false })

    snapshot(h, 'idle', state('low'))
    call.mockRejectedValue(new Error('unavailable'))
    expect(await getState(h)).toMatchObject({ success: true, data: { thinkingLevel: 'low' } })
  })

  it('treats a snapshot of a running lane after a stop as a new run, too', async () => {
    const h = handle()
    snapshot(h, 'idle', state('high'))
    snapshot(h, 'stopped', null)
    snapshot(h, 'working', null)
    call.mockRejectedValue(new Error('unavailable'))
    expect(await getState(h)).toMatchObject({ success: false })
  })
})
