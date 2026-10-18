import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utf8Length, type FrameSocket, type HostFrame } from '../../host-protocol'
import { catchUp, recover, send } from './delivery'
import {
  createFakeHostState,
  type Connection,
  type FakeHostState,
  type Lane,
  type Limits,
} from './state'

const LANE = '00000000-0000-4000-8000-000000000001'

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
function connection() {
  const wire = { open: true, buffered: 0, frames: [] as HostFrame[], closes: [] as string[] }
  const socket: FrameSocket = {
    send: (text) => void wire.frames.push(JSON.parse(text)),
    close: (code, reason) => {
      wire.open = false
      wire.closes.push(`${code} ${reason}`)
    },
    onMessage: () => undefined,
    onClose: () => undefined,
    isOpen: () => wire.open,
    bufferedBytes: () => wire.buffered,
  }
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const c: Connection = {
    socket,
    grant: null,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  }
  return { c, wire }
}
function addLane(state: FakeHostState): Lane {
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
    seq: 4,
    events: [],
    replayBytes: 0,
    messages: [],
    pending: [],
    dialogs: [],
    ui: new Map(),
  }
  state.lanes.set(LANE, lane)
  return lane
}
const event = (id: string, text: string): HostFrame => ({
  type: 'event',
  id,
  laneId: LANE,
  cursor: { epoch: 'epoch', seq: 5 },
  event: { kind: 'dialog-resolved', dialogId: text },
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('send', () => {
  it('drops every frame for a closed socket', () => {
    const { c, wire } = connection()
    wire.open = false
    expect(send(host(), c, { type: 'pong', at: 1 })).toBe('dropped')
    expect(wire.frames).toEqual([])
  })

  it('measures UTF-8 bytes, not characters, against the outbound limit', () => {
    const data = 'é'.repeat(40)
    const frame: HostFrame = { type: 'result', id: 'r', ok: true, data }
    const text = JSON.stringify(frame)
    expect([text.length, utf8Length(text)]).toEqual([86, 126])
    const exact = connection()
    expect(send(host({ outboundFrameBytes: 126 }), exact.c, frame)).toBe('sent')
    expect(exact.wire.frames).toEqual([frame])
    const over = connection()
    expect(send(host({ outboundFrameBytes: 125 }), over.c, frame)).toBe('sent')
    expect(over.wire.frames).toEqual([
      {
        type: 'result',
        id: 'r',
        ok: false,
        error: { code: 'too-large', message: 'Result too large' },
      },
    ])
  })

  it('fails only an oversize subscription frame and closes on any other oversize frame', () => {
    const state = host({ outboundFrameBytes: 100 })
    const { c, wire } = connection()
    c.subscriptions.set('all', { type: 'subscribe', id: 'all', topic: 'lanes' })
    const lanes: HostFrame = {
      type: 'lanes',
      id: 'all',
      cursor: { epoch: 'epoch', seq: 0 },
      repositories: [{ id: '0123456789abcdef', name: 'x'.repeat(100), path: '/test' }],
      lanes: [],
    }
    expect(send(state, c, lanes)).toBe('failed')
    expect(wire.frames).toEqual([{ type: 'subscribe-failed', id: 'all', code: 'too-large' }])
    expect([c.subscriptions.size, c.stale.size, wire.open]).toEqual([0, 0, true])
    expect(send(state, c, { type: 'auth-renewed', grantExpiresAt: 'x'.repeat(100) })).toBe('failed')
    expect(wire.closes).toEqual(['4429 Outbound limit'])
  })

  it('resets an oversize event to a snapshot, and fails it when the snapshot is oversize too', () => {
    const state = host({ outboundFrameBytes: 700 })
    const lane = addLane(state)
    const { c, wire } = connection()
    c.subscriptions.set('lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    expect(send(state, c, event('lane', 'x'.repeat(700)))).toBe('reset')
    expect(wire.frames).toMatchObject([
      { type: 'snapshot', id: 'lane', reset: true, snapshot: { cursor: { seq: 4 } } },
    ])
    lane.messages.push({ role: 'user', content: 'x'.repeat(700), timestamp: 0 })
    expect(send(state, c, event('lane', 'x'.repeat(700)))).toBe('failed')
    expect(wire.frames.at(-1)).toEqual({ type: 'subscribe-failed', id: 'lane', code: 'too-large' })
    expect(c.subscriptions.has('lane')).toBe(false)
  })

  it('drops an oversize event whose lane no longer exists', () => {
    const state = host({ outboundFrameBytes: 100 })
    const { c, wire } = connection()
    c.subscriptions.set('lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    expect(send(state, c, event('lane', 'x'.repeat(100)))).toBe('dropped')
    expect(wire.frames).toEqual([])
    expect(c.subscriptions.has('lane')).toBe(true)
  })

  it('marks a subscription stale on a full queue and closes a slow non-subscription stream', () => {
    const state = host({ sendQueueBytes: 1000 })
    addLane(state)
    const { c, wire } = connection()
    c.subscriptions.set('lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    wire.buffered = 1000 - utf8Length(JSON.stringify(event('lane', 'a')))
    expect(send(state, c, event('lane', 'a'))).toBe('sent')
    wire.buffered += 1
    expect(send(state, c, event('lane', 'a'))).toBe('dropped')
    expect([...c.stale]).toEqual(['lane'])
    expect(c.recoveryTimer).toBeDefined()
    wire.buffered = 0
    expect(send(state, c, event('lane', 'b'))).toBe('dropped')
    expect(wire.frames).toHaveLength(1)
    wire.buffered = 1000
    expect(send(state, c, { type: 'pong', at: 1 })).toBe('dropped')
    expect(wire.closes).toEqual(['4429 Slow client'])
  })
})

describe('recover', () => {
  it('retries every 50ms until the queue is below half, then sends one catch-up per subscription', async () => {
    const state = host({ sendQueueBytes: 10_000 })
    addLane(state)
    const { c, wire } = connection()
    c.subscriptions.set('lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    c.subscriptions.set('all', { type: 'subscribe', id: 'all', topic: 'lanes' })
    c.stale.add('lane').add('all')
    wire.buffered = 5000
    recover(state, c)
    recover(state, c)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    expect([wire.frames.length, c.stale.size, vi.getTimerCount()]).toEqual([0, 2, 1])
    wire.buffered = 4999
    await vi.advanceTimersByTimeAsync(50)
    expect(wire.frames.map((f) => f.type)).toEqual(['snapshot', 'lanes'])
    expect([c.stale.size, c.recoveryTimer, vi.getTimerCount()]).toEqual([0, undefined, 0])
  })

  it('stops retrying once the socket has closed', async () => {
    const state = host()
    const { c, wire } = connection()
    c.stale.add('lane')
    recover(state, c)
    wire.open = false
    await vi.advanceTimersByTimeAsync(50)
    expect([wire.frames.length, c.stale.size, c.recoveryTimer, vi.getTimerCount()]).toEqual([
      0,
      1,
      undefined,
      0,
    ])
  })
})

describe('catchUp', () => {
  it('builds the current lanes list or lane snapshot for a live subscription only', () => {
    const state = host()
    const lane = addLane(state)
    state.hostSeq = 3
    const { c } = connection()
    expect(catchUp(state, c, 'missing')).toBeNull()
    c.subscriptions.set('all', { type: 'subscribe', id: 'all', topic: 'lanes' })
    expect(catchUp(state, c, 'all')).toEqual({
      type: 'lanes',
      id: 'all',
      cursor: { epoch: 'epoch', seq: 3 },
      repositories: state.repositories,
      lanes: [lane.summary],
    })
    c.subscriptions.set('lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    expect(catchUp(state, c, 'lane')).toMatchObject({ type: 'snapshot', reset: true })
    state.lanes.clear()
    expect(catchUp(state, c, 'lane')).toBeNull()
  })
})
