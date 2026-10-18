import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utf8Length, type FrameSocket, type HostFrame } from '../../host-protocol'
import type { SendFrame } from './delivery'
import {
  createFakeHostState,
  type Connection,
  type FakeHostState,
  type Lane,
  type Limits,
} from './state'
import { announce, changeControl, notify, publish, push, snapshot, summary, turn } from './streams'

const LANE = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'

function host(limits: Partial<Limits> = {}): FakeHostState {
  return createFakeHostState({
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => LANE,
    epoch: () => 'epoch',
    limits,
  })
}
/** Stream helpers only reach sockets through the injected send, so this one never acts. */
const inertSocket: FrameSocket = {
  send: () => undefined,
  close: () => undefined,
  onMessage: () => undefined,
  onClose: () => undefined,
  isOpen: () => true,
  bufferedBytes: () => 0,
}
function subscriber(state: FakeHostState, ...subscriptions: [string, string | null][]) {
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const c: Connection = {
    socket: inertSocket,
    grant: null,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  }
  for (const [id, laneId] of subscriptions)
    c.subscriptions.set(
      id,
      laneId === null
        ? { type: 'subscribe', id, topic: 'lanes' }
        : { type: 'subscribe', id, topic: 'lane', laneId },
    )
  state.connections.add(c)
  return c
}
function recorder() {
  const frames: [Connection, HostFrame][] = []
  const send: SendFrame = (_state, c, frame) => {
    frames.push([c, frame])
    return 'sent'
  }
  return { frames, send, types: () => frames.map(([, f]) => brief(f)) }
}
function brief(f: HostFrame): string {
  if (f.type === 'event')
    return `${f.id}:${f.cursor.seq}:${f.event.kind === 'pi' && f.event.push.kind === 'event' ? f.event.push.event.type : f.event.kind}`
  if (f.type === 'lanes-delta' || f.type === 'attention') return `${f.id}:${f.type}:${f.cursor.seq}`
  return `${'id' in f ? f.id : ''}:${f.type}`
}
function addLane(state: FakeHostState, laneId = LANE): Lane {
  const lane: Lane = {
    summary: {
      laneId,
      repositoryId: '0123456789abcdef',
      cwd: '/test',
      title: null,
      branch: null,
      worktree: false,
      model: null,
      activity: 'idle',
      createdAt: 'then',
      updatedAt: 'then',
      attention: 0,
      read: 0,
      control: { fence: 1, controller: null },
    },
    thinkingLevel: 'off',
    sessionId: 'session',
    seq: 0,
    events: [],
    replayBytes: 0,
    messages: [],
    pending: [],
    dialogs: [],
    ui: new Map(),
  }
  state.lanes.set(laneId, lane)
  return lane
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('publish', () => {
  it('numbers lane events and streams them only to that lane', () => {
    const state = host()
    const lane = addLane(state)
    addLane(state, OTHER)
    const a = subscriber(state, ['lane', LANE], ['other', OTHER], ['all', null])
    const b = subscriber(state, ['mine', LANE])
    const r = recorder()
    publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: 'one' })
    publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: 'two' })
    expect(r.types()).toEqual([
      'lane:1:dialog-resolved',
      'mine:1:dialog-resolved',
      'lane:2:dialog-resolved',
      'mine:2:dialog-resolved',
    ])
    expect(r.frames.map(([c]) => c)).toEqual([a, b, a, b])
    expect(lane.events.map((e) => e.cursor)).toEqual([
      { epoch: 'epoch', seq: 1 },
      { epoch: 'epoch', seq: 2 },
    ])
  })

  it('keeps replay within the event count and byte limits with exact byte accounting', () => {
    const state = host({ replayEvents: 3, replayBytes: 140 })
    const lane = addLane(state)
    const r = recorder()
    const bytes = (dialogId: string) =>
      utf8Length(JSON.stringify({ kind: 'dialog-resolved', dialogId }))
    for (const id of ['a', 'b', 'c', 'd'])
      publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: id })
    expect(lane.events.map((e) => e.cursor.seq)).toEqual([2, 3, 4])
    expect(lane.replayBytes).toBe(3 * bytes('a'))
    publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: 'é'.repeat(40) })
    expect(lane.events.map((e) => e.cursor.seq)).toEqual([5])
    expect(lane.events[0]?.bytes).toBe(bytes('é'.repeat(40)))
    expect(lane.replayBytes).toBe(lane.events[0]?.bytes)
    publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: 'é'.repeat(60) })
    expect([lane.events.length, lane.replayBytes, lane.seq]).toEqual([0, 0, 6])
  })

  it('sends a reset snapshot in place of an event frame over the outbound limit', () => {
    const state = host({ outboundFrameBytes: 600 })
    const lane = addLane(state)
    subscriber(state, ['lane', LANE])
    const r = recorder()
    publish(state, r.send, lane, { kind: 'dialog-resolved', dialogId: 'x'.repeat(600) })
    expect(r.frames.map(([, f]) => f)).toEqual([
      { type: 'snapshot', id: 'lane', laneId: LANE, reset: true, snapshot: snapshot(state, lane) },
    ])
    expect(lane.seq).toBe(1)
  })
})

describe('summaries, attention and control', () => {
  it('announces a summary to lanes subscriptions with one Host sequence step', () => {
    const state = host()
    const lane = addLane(state)
    subscriber(state, ['lane', LANE], ['all', null])
    const r = recorder()
    summary(state, r.send, lane)
    expect(lane.summary.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(r.types()).toEqual(['lane:1:summary', 'all:lanes-delta:1'])
    announce(state, r.send, lane)
    expect(r.frames.at(-1)?.[1]).toEqual({
      type: 'lanes-delta',
      id: 'all',
      cursor: { epoch: 'epoch', seq: 2 },
      upsert: [lane.summary],
      remove: [],
    })
  })

  it('counts attention, keeps only the replay window and streams it to lanes subscriptions', () => {
    const state = host({ attentionReplay: 1 })
    const lane = addLane(state)
    subscriber(state, ['all', null])
    const r = recorder()
    notify(state, r.send, lane, 'finished')
    notify(state, r.send, lane, 'needs-input')
    expect(r.types()).toEqual([
      'all:lanes-delta:1',
      'all:attention:2',
      'all:lanes-delta:3',
      'all:attention:4',
    ])
    expect(lane.summary.attention).toBe(2)
    expect(state.attention).toEqual([
      {
        cursor: { epoch: 'epoch', seq: 4 },
        event: {
          id: `${LANE}:2`,
          laneId: LANE,
          kind: 'needs-input',
          attention: 2,
          at: '2026-01-01T00:00:00.000Z',
          title: null,
        },
      },
    ])
  })

  it('advances the fence and publishes control before the summary', () => {
    const state = host()
    const lane = addLane(state)
    subscriber(state, ['lane', LANE])
    const r = recorder()
    const controller = { clientId: 'client', label: 'Viewer', connected: true }
    changeControl(state, r.send, lane, controller)
    expect(lane.summary.control).toEqual({ fence: 2, controller })
    expect(r.types()).toEqual(['lane:1:control', 'lane:2:summary'])
  })
})

describe('pending events and turns', () => {
  it('refuses a pending event over the limit without publishing it', () => {
    const state = host({ pendingEvents: 1 })
    const lane = addLane(state)
    const r = recorder()
    push(state, r.send, lane, { type: 'agent_start' })
    expect(() => push(state, r.send, lane, { type: 'agent_start' })).toThrow(
      'Scripted pending limit exceeded',
    )
    expect([lane.pending.length, lane.seq]).toEqual([1, 1])
  })

  it('scripts one turn in order, settles its message and clears pending', () => {
    const state = host()
    const lane = addLane(state)
    subscriber(state, ['lane', LANE])
    const r = recorder()
    expect(turn(state, r.send, lane)).toEqual({ messages: 1, turns: 1 })
    expect(r.types()).toEqual([
      'lane:1:summary',
      'lane:2:agent_start',
      'lane:3:message_update',
      'lane:4:message_update',
      'lane:5:message_end',
      'lane:6:agent_end',
      'lane:7:summary',
    ])
    expect(lane.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Scripted reply' }],
        timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    ])
    expect(lane.pending).toEqual([])
    expect(lane.summary).toMatchObject({ activity: 'idle', attention: 1 })
  })
})

describe('snapshot', () => {
  it('projects live state, shares the lane collections and lists UI in insertion order', () => {
    const state = host()
    const lane = addLane(state)
    lane.summary = { ...lane.summary, title: 'Named', activity: 'working' }
    lane.seq = 9
    lane.ui.set('status:b', {
      type: 'extension_ui_request',
      id: 'b',
      method: 'setTitle',
      title: 'b',
    })
    lane.ui.set('status:a', {
      type: 'extension_ui_request',
      id: 'a',
      method: 'setTitle',
      title: 'a',
    })
    const s = snapshot(state, lane)
    expect(s.cursor).toEqual({ epoch: 'epoch', seq: 9 })
    expect(s.state).toMatchObject({ isStreaming: true, sessionName: 'Named', messageCount: 0 })
    expect([s.messages, s.pending, s.dialogs]).toEqual([lane.messages, lane.pending, lane.dialogs])
    expect(s.messages).toBe(lane.messages)
    expect(s.ui.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('omits the session name without a title and the state once stopped or failed', () => {
    const state = host()
    const lane = addLane(state)
    expect(snapshot(state, lane).state).not.toHaveProperty('sessionName')
    for (const activity of ['stopped', 'failed'] as const) {
      lane.summary = { ...lane.summary, activity }
      expect(snapshot(state, lane).state).toBeNull()
    }
  })
})
