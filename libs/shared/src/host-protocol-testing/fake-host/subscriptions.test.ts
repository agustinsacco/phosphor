import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantPayload } from '../../host-grant'
import { utf8Length, type ClientFrame, type FrameSocket, type HostFrame } from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import {
  createFakeHostState,
  type Connection,
  type FakeHostState,
  type Lane,
  type Limits,
} from './state'
import { publish } from './streams'
import { subscribe, unsubscribe } from './subscriptions'

const LANE = '00000000-0000-4000-8000-000000000001'
type Subscribe = Extract<ClientFrame, { type: 'subscribe' }>

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
function viewer(state: FakeHostState, caps: HostCapability[] = ['sessions.read']) {
  const wire = { buffered: 0, filling: false, frames: [] as HostFrame[] }
  const socket: FrameSocket = {
    send: (text) => {
      wire.frames.push(JSON.parse(text))
      if (wire.filling) wire.buffered += utf8Length(text)
    },
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    isOpen: () => true,
    bufferedBytes: () => wire.buffered,
  }
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const grant: GrantPayload = {
    v: 1,
    iss: 'https://control.test',
    kid: 'key',
    sub: 'owner',
    sid: 'session',
    hostId: 'host',
    epoch: 1,
    client: { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' },
    caps,
    iat: 0,
    exp: 300,
    jti: '0123456789abcdef',
  }
  const c: Connection = {
    socket,
    grant,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  }
  state.connections.add(c)
  const brief = () =>
    wire.frames.map((f) =>
      f.type === 'event'
        ? `event ${f.cursor.seq}`
        : f.type === 'snapshot'
          ? `snapshot ${f.reset ? 'reset' : 'fresh'} ${f.snapshot.cursor.seq}`
          : f.type === 'subscribe-failed'
            ? `failed ${f.code}`
            : f.type === 'attention'
              ? `attention ${f.cursor.seq}`
              : f.type,
    )
  return { c, wire, brief }
}
/** A lane with events 1..count published, of which the replay window keeps what the limits allow. */
function laneWith(state: FakeHostState, count: number, text = 'x'): Lane {
  const lane: Lane = {
    summary: {
      laneId: LANE,
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
  state.lanes.set(LANE, lane)
  for (let i = 0; i < count; i++)
    publish(state, () => 'sent', lane, { kind: 'dialog-resolved', dialogId: text })
  return lane
}
const lane = (id: string, seq?: number, epoch = 'epoch'): Subscribe => ({
  type: 'subscribe',
  id,
  topic: 'lane',
  laneId: LANE,
  ...(seq === undefined ? {} : { after: { epoch, seq } }),
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('subscribe', () => {
  it('refuses by topic, authority, duplicate id, count and unknown lane, in that order', () => {
    const state = host({ subscriptionsPerConnection: 1 })
    const blind = viewer(state, [])
    subscribe(state, blind.c, { type: 'subscribe', topic: 'terminal', id: 't', terminalId: LANE })
    subscribe(state, blind.c, lane('l'))
    const v = viewer(state)
    subscribe(state, v.c, lane('missing'))
    subscribe(state, v.c, { type: 'subscribe', id: 'all', topic: 'lanes' })
    subscribe(state, v.c, { type: 'subscribe', id: 'all', topic: 'lanes' })
    subscribe(state, v.c, lane('other'))
    expect([blind.brief(), v.brief()]).toEqual([
      ['failed bad-request', 'failed forbidden'],
      ['failed unknown-lane', 'lanes', 'failed bad-request', 'failed too-many'],
    ])
    expect([...v.c.subscriptions.keys()]).toEqual(['all'])
  })

  it('replays exactly inside the window, sends nothing at the head and resets outside it', () => {
    const state = host({ replayEvents: 3 })
    laneWith(state, 6)
    const outcomes = [6, 3, 2, 7].map((seq) => {
      const v = viewer(state)
      subscribe(state, v.c, lane('l', seq))
      return v.brief().join(',')
    })
    const other = viewer(state)
    subscribe(state, other.c, lane('l', 5, 'old'))
    const fresh = viewer(state)
    subscribe(state, fresh.c, lane('l'))
    expect([...outcomes, other.brief().join(','), fresh.brief().join(',')]).toEqual([
      '',
      'event 4,event 5,event 6',
      'snapshot reset 6',
      'snapshot reset 6',
      'snapshot reset 6',
      'snapshot fresh 6',
    ])
  })

  it('treats an empty window as replayable only at the head', () => {
    const state = host({ replayBytes: 1 })
    const l = laneWith(state, 2)
    expect([l.seq, l.events.length]).toEqual([2, 0])
    const head = viewer(state),
      behind = viewer(state)
    subscribe(state, head.c, lane('l', 2))
    subscribe(state, behind.c, lane('l', 1))
    expect([head.brief(), behind.brief()]).toEqual([[], ['snapshot reset 2']])
  })

  it('stops replaying after an event is reset to a snapshot or the queue is full', () => {
    const state = host({ outboundFrameBytes: 1200 })
    const l = laneWith(state, 1)
    publish(state, () => 'sent', l, { kind: 'dialog-resolved', dialogId: 'x'.repeat(1200) })
    publish(state, () => 'sent', l, { kind: 'dialog-resolved', dialogId: 'after' })
    const v = viewer(state)
    subscribe(state, v.c, lane('l', 0))
    expect(v.brief()).toEqual(['event 1', 'snapshot reset 3'])
    const slow = viewer(state)
    slow.wire.buffered = state.limits.sendQueueBytes - 200
    subscribe(state, slow.c, lane('l', 0))
    expect([slow.brief(), [...slow.c.stale]]).toEqual([['event 1'], ['l']])
  })

  it('replays attention after the cursor in this epoch until a send is not sent', () => {
    const state = host()
    for (const seq of [1, 2, 3])
      state.attention.push({
        cursor: { epoch: 'epoch', seq },
        event: {
          id: `a:${seq}`,
          laneId: LANE,
          kind: 'finished',
          attention: seq,
          at: 'now',
          title: null,
        },
      })
    state.hostSeq = 3
    const all = (id: string, seq: number, epoch = 'epoch'): Subscribe => ({
      type: 'subscribe',
      id,
      topic: 'lanes',
      after: { epoch, seq },
    })
    const v = viewer(state)
    subscribe(state, v.c, all('a', 1))
    subscribe(state, v.c, all('b', 0, 'old'))
    expect(v.brief()).toEqual(['lanes', 'attention 2', 'attention 3', 'lanes'])
    const [lanesBytes = 0, attentionBytes = 0] = v.wire.frames.map((f) =>
      utf8Length(JSON.stringify(f)),
    )
    const slow = viewer(state)
    slow.wire.filling = true
    slow.wire.buffered = state.limits.sendQueueBytes - lanesBytes - attentionBytes
    subscribe(state, slow.c, all('a', 0))
    expect([slow.brief(), [...slow.c.stale]]).toEqual([['lanes', 'attention 1'], ['a']])
  })
})

it('unsubscribes a subscription and its stale mark', () => {
  const state = host()
  const v = viewer(state)
  v.c.subscriptions.set('a', { type: 'subscribe', id: 'a', topic: 'lanes' })
  v.c.stale.add('a')
  unsubscribe(v.c, 'a')
  unsubscribe(v.c, 'missing')
  expect([v.c.subscriptions.size, v.c.stale.size]).toEqual([0, 0])
})
