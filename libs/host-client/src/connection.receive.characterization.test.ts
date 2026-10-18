import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HOST_LIMITS,
  parseClientFrame,
  type ClientFrame,
  type FrameSocket,
} from '@phosphor/shared/host-protocol'
import { createHostConnection, type LaneFrame } from './connection'

// Characterization (DM-16): authenticated frame routing, cursors, attention,
// lane and terminal subscriptions, pinned through createHostConnection over a
// scripted socket before receive moved out. Frozen: append cases, never edit.
const hostId = '11111111-1111-4111-8111-111111111111'
const laneA = '22222222-2222-4222-8222-222222222222'
const laneB = '44444444-4444-4444-8444-444444444444'
const terminalId = '33333333-3333-4333-8333-333333333333'
const endpoint = 'https://fixture.tail.ts.net:47615'
const epochA = 'a'.repeat(16)
const epochB = 'b'.repeat(16)
const time = '2026-01-01T00:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const readyFrame = () => ({
  type: 'ready',
  protocolVersion: 1,
  hello: {
    hostId,
    hostVersion: '1.0.0',
    protocolVersion: 1,
    runtimeEpoch: epochA,
    capabilities: [],
  },
  proof: 'A'.repeat(86),
  connectionId: 'b'.repeat(16),
  grantExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  client: { id: hostId, label: 'Test' },
  capabilities: [],
})
const summary = (laneId: string, title: string | null = null, fence = 1) => ({
  laneId,
  repositoryId: 'c'.repeat(16),
  cwd: '/fixture',
  title,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: time,
  updatedAt: time,
  attention: 0,
  read: 0,
  control: { fence, controller: null },
})
const cursor = (seq: number, epoch = epochA) => ({ epoch, seq })
const lanes = (seq: number, list = [summary(laneA)], epoch = epochA) => ({
  type: 'lanes',
  id: 'lanes',
  cursor: cursor(seq, epoch),
  repositories: [],
  lanes: list,
})
const delta = (seq: number, upsert: unknown[], remove: string[] = [], epoch = epochA) => ({
  type: 'lanes-delta',
  id: 'lanes',
  cursor: cursor(seq, epoch),
  upsert,
  remove,
})
const attention = (seq: number, n: number, epoch = epochA) => ({
  type: 'attention',
  id: 'lanes',
  cursor: cursor(seq, epoch),
  event: {
    id: `${laneA}:${n}`,
    laneId: laneA,
    kind: 'finished',
    attention: n,
    at: time,
    title: null,
  },
})
const routines = (seq: number, epoch = epochA) => ({
  type: 'routines-changed',
  id: 'lanes',
  cursor: cursor(seq, epoch),
})
const snapshot = (id: string, seq: number, reset = false, epoch = epochA, title = 'Snap') => ({
  type: 'snapshot',
  id,
  laneId: laneA,
  reset,
  snapshot: {
    cursor: cursor(seq, epoch),
    summary: summary(laneA, title),
    state: null,
    messages: [],
    pending: [],
    dialogs: [],
    ui: [],
  },
})
const event = (id: string, seq: number, body: unknown, epoch = epochA, laneId = laneA) => ({
  type: 'event',
  id,
  laneId,
  cursor: cursor(seq, epoch),
  event: body,
})

function scriptedSocket() {
  const sent: ClientFrame[] = []
  const closes: [number, string][] = []
  let message: (text: string) => void = () => {}
  let closed: (code: number, reason: string) => void = () => {}
  const wire = {
    sent,
    closes,
    open: true,
    full: false,
    host: (frame: unknown) => message(JSON.stringify(frame)),
    drop(code: number) {
      if (!wire.open) return
      wire.open = false
      void Promise.resolve().then(() => closed(code, ''))
    },
    subscribes: () => sent.filter((f) => f.type === 'subscribe' || f.type === 'unsubscribe'),
  }
  const socket: FrameSocket = {
    send(text) {
      const parsed = parseClientFrame(text)
      if (!parsed.ok) throw new Error(`Invalid client frame: ${parsed.reason}`)
      sent.push(parsed.frame)
      const frame = parsed.frame
      if (frame.type === 'ping')
        void Promise.resolve().then(() => wire.host({ type: 'pong', at: frame.at }))
    },
    close(code, reason) {
      closes.push([code, reason])
      wire.drop(code)
    },
    onMessage: (cb) => {
      message = cb
    },
    onClose: (cb) => {
      closed = cb
    },
    isOpen: () => wire.open,
    bufferedBytes: () => (wire.full ? HOST_LIMITS.sendQueueBytes : 0),
  }
  return Object.assign(wire, { socket })
}

async function connect() {
  let n = 0
  const sockets: ReturnType<typeof scriptedSocket>[] = []
  const changed = vi.fn()
  const onAttention = vi.fn()
  const onRoutinesChanged = vi.fn()
  const unrefTimer = vi.fn()
  const connection = createHostConnection({
    hostId,
    endpoint,
    identity: {
      randomUUID: () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`,
      randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, '0'),
      verify: () => true,
    },
    socket: async () => {
      const wire = scriptedSocket()
      sockets.push(wire)
      return wire.socket
    },
    grant: async () => ({
      grant: 'fixture-grant',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      host: { id: hostId, endpoint, publicKey: 'fixture-key' },
    }),
    clearGrant: () => {},
    changed,
    onAttention,
    onRoutinesChanged,
    unrefTimer,
    random: () => 1,
  })
  await flush()
  const socket = () => {
    const wire = sockets.at(-1)
    if (!wire) throw new Error('No socket')
    return wire
  }
  return {
    connection,
    sockets,
    changed,
    onAttention,
    onRoutinesChanged,
    unrefTimer,
    socket,
    host: (frame: unknown) => socket().host(frame),
    ready: () => socket().host(readyFrame()),
    async reconnect(code = 1001) {
      socket().drop(code)
      await flush()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
    },
  }
}
/** The id of the newest lane subscription, which the Host echoes on its frames. */
function laneSubscription(t: Awaited<ReturnType<typeof connect>>) {
  const frame = t
    .socket()
    .sent.filter((f) => f.type === 'subscribe' && f.topic === 'lane')
    .at(-1)
  if (frame?.type !== 'subscribe') throw new Error('No lane subscription')
  return frame
}

it('closes on a duplicate ready or an unexpected renewal and ignores error frames', async () => {
  const t = await connect()
  t.ready()
  t.host({ type: 'error', code: 4403, message: 'Late' })
  expect(t.socket().closes).toEqual([])
  expect(t.connection.snapshot().state).toBe('ready')
  t.ready()
  expect(t.socket().closes).toEqual([[4400, 'Duplicate ready']])
  await t.reconnect()
  t.ready()
  t.host({ type: 'auth-renewed', grantExpiresAt: new Date(Date.now() + 300_000).toISOString() })
  expect(t.socket().closes).toEqual([[4400, 'Unexpected renewal']])
  t.connection.close()
})

it('keeps the highest cursor within an epoch and clears attention on a new epoch', async () => {
  const t = await connect()
  t.ready()
  t.host(lanes(5))
  expect(t.connection.snapshot()).toMatchObject({ lanes: [{ laneId: laneA }], cursor: cursor(5) })
  t.host(attention(6, 1))
  t.host(lanes(3, [summary(laneA), summary(laneB)]))
  expect(t.connection.snapshot().cursor).toEqual(cursor(6))
  expect(t.connection.snapshot().lanes.map((l) => l.laneId)).toEqual([laneA, laneB])
  expect(t.connection.attention()).toHaveLength(1)
  t.host(lanes(1, [], epochB))
  expect(t.connection.snapshot()).toMatchObject({ lanes: [], cursor: cursor(1, epochB) })
  expect(t.connection.attention()).toEqual([])
  t.host({ ...lanes(9), id: 'other' })
  expect(t.connection.snapshot().cursor).toEqual(cursor(1, epochB))
  expect(t.socket().closes).toEqual([])
  t.connection.close()
})

it('ignores lanes-topic frames from a foreign epoch or before the first list', async () => {
  const t = await connect()
  t.ready()
  t.host(delta(1, [summary(laneB)]))
  t.host(attention(1, 1))
  t.host(routines(1))
  expect(t.connection.snapshot().lanes).toEqual([])
  expect(t.connection.snapshot().cursor).toBeUndefined()
  t.host(lanes(4))
  const changes = t.changed.mock.calls.length
  t.host(delta(5, [summary(laneB)], [], epochB))
  t.host(attention(5, 1, epochB))
  t.host(routines(5, epochB))
  expect(t.connection.snapshot()).toMatchObject({ lanes: [{ laneId: laneA }], cursor: cursor(4) })
  expect(t.connection.attention()).toEqual([])
  expect(t.onAttention).not.toHaveBeenCalled()
  expect(t.onRoutinesChanged).not.toHaveBeenCalled()
  expect(t.changed.mock.calls.length).toBe(changes)
  expect(t.socket().subscribes()).toHaveLength(1)
  t.connection.close()
})

it('applies the next delta, ignores stale ones, resubscribes on a gap and bounds lanes', async () => {
  const t = await connect()
  t.ready()
  t.host(lanes(4))
  t.host(delta(4, [summary(laneB)]))
  expect(t.connection.snapshot().lanes).toHaveLength(1)
  t.host(delta(6, [summary(laneB)]))
  expect(t.connection.snapshot()).toMatchObject({ lanes: [{ laneId: laneA }], cursor: cursor(4) })
  expect(t.socket().subscribes().at(-1)).toEqual({
    type: 'subscribe',
    id: 'lanes',
    topic: 'lanes',
    trace: expect.stringMatching(/^[0-9a-f]{16}$/),
  })
  t.host(delta(5, [summary(laneB, 'New')], [laneA]))
  expect(t.connection.snapshot()).toMatchObject({
    lanes: [{ laneId: laneB, title: 'New' }],
    cursor: cursor(5),
  })
  const many = Array.from({ length: HOST_LIMITS.lanesPerHost }, (_, i) =>
    summary(`00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`),
  )
  t.host(delta(6, many))
  expect(t.socket().closes).toEqual([[4400, 'Lane limit']])
  expect(t.connection.snapshot().lanes).toHaveLength(1)
  t.connection.close()
})

it('advances the cursor on routines-changed without publishing a view change', async () => {
  const t = await connect()
  t.ready()
  t.host(lanes(2))
  const changes = t.changed.mock.calls.length
  t.host(routines(3))
  expect(t.onRoutinesChanged).toHaveBeenCalledTimes(1)
  expect(t.connection.snapshot().cursor).toEqual(cursor(3))
  t.host(routines(3))
  expect(t.onRoutinesChanged).toHaveBeenCalledTimes(1)
  const subscribes = t.socket().subscribes().length
  t.host(routines(7))
  expect(t.onRoutinesChanged).toHaveBeenCalledTimes(2)
  expect(t.connection.snapshot().cursor).toEqual(cursor(7))
  expect(t.socket().subscribes()).toHaveLength(subscribes + 1)
  expect(t.changed.mock.calls.length).toBe(changes)
  t.connection.close()
})

it('dedupes attention by id, orders it by sequence and keeps the newest 50', async () => {
  const t = await connect()
  t.ready()
  t.host(lanes(1))
  t.host(attention(9, 3))
  t.host(attention(4, 2))
  expect(t.connection.snapshot().cursor).toEqual(cursor(9))
  expect(t.connection.attention().map((a) => a.cursor.seq)).toEqual([4, 9])
  const changes = t.changed.mock.calls.length
  t.host(attention(12, 2))
  expect(t.onAttention).toHaveBeenCalledTimes(2)
  expect(t.connection.attention().map((a) => a.cursor.seq)).toEqual([4, 9])
  expect(t.connection.snapshot().cursor).toEqual(cursor(12))
  expect(t.changed.mock.calls.length).toBe(changes + 1)
  for (let i = 0; i < 50; i++) t.host(attention(100 + i, 10 + i))
  const kept = t.connection.attention()
  expect(kept).toHaveLength(50)
  expect(kept[0]?.cursor.seq).toBe(100)
  expect(kept.at(-1)?.cursor.seq).toBe(149)
  expect(t.onAttention).toHaveBeenCalledTimes(52)
  expect(t.onAttention).toHaveBeenLastCalledWith(attention(149, 59).event)
  t.connection.close()
  expect(t.connection.attention()).toEqual([])
})

it('resets lane snapshots, recovers event gaps and folds summaries into the view', async () => {
  const t = await connect()
  t.ready()
  t.host(lanes(1))
  const frames: LaneFrame[] = []
  t.connection.watchLane(laneA, (f) => frames.push(f))
  const { id } = laneSubscription(t)
  t.host(snapshot(id, 3))
  expect(frames.at(-1)).toMatchObject({ type: 'snapshot', reset: false })
  expect(t.connection.snapshot().lanes[0]?.title).toBe('Snap')
  t.host(event(id, 4, { kind: 'control', control: { fence: 2, controller: null } }))
  expect(t.connection.snapshot().lanes[0]?.control.fence).toBe(2)
  t.host(event(id, 5, { kind: 'summary', summary: summary(laneA, 'Summary') }))
  expect(t.connection.snapshot().lanes[0]?.title).toBe('Summary')
  t.host(event(id, 6, { kind: 'dialog-resolved', dialogId: 'd' }))
  expect(frames.map((f) => f.type)).toEqual(['snapshot', 'event', 'event', 'event'])
  const before = t.socket().subscribes().length
  t.host(event(id, 9, { kind: 'dialog-resolved', dialogId: 'd' }))
  t.host(event(id, 7, { kind: 'dialog-resolved', dialogId: 'd' }, epochB))
  expect(frames).toHaveLength(4)
  expect(t.socket().subscribes().slice(before)).toEqual([
    { type: 'subscribe', id, topic: 'lane', laneId: laneA, trace: expect.any(String) },
    { type: 'subscribe', id, topic: 'lane', laneId: laneA, trace: expect.any(String) },
  ])
  t.host(snapshot(id, 10, true))
  expect(frames.at(-1)).toMatchObject({ type: 'snapshot', reset: true })
  t.host(snapshot(id, 1, false, epochB))
  expect(frames.at(-1)).toMatchObject({ type: 'snapshot', reset: true })
  t.host(snapshot(id, 2, false, epochB))
  expect(frames.at(-1)).toMatchObject({ type: 'snapshot', reset: false })
  t.host(event(id, 3, { kind: 'dialog-resolved', dialogId: 'd' }, epochB, laneB))
  t.host(event('stranger', 3, { kind: 'dialog-resolved', dialogId: 'd' }, epochB))
  expect(frames).toHaveLength(7)
  expect(t.socket().closes).toEqual([])
  t.connection.close()
})

it('routes subscribe-failed to its terminal, lane watch or the lanes list', async () => {
  const t = await connect()
  t.ready()
  const laneFrames: LaneFrame[] = []
  const terminalFrames: unknown[] = []
  t.connection.watchLane(laneA, (f) => laneFrames.push(f))
  t.connection.watchTerminal(terminalId, (f) => terminalFrames.push(f))
  const [, lane, terminal] = t.socket().subscribes()
  if (lane?.type !== 'subscribe' || terminal?.type !== 'subscribe') throw new Error('No subs')
  t.host({ type: 'subscribe-failed', id: terminal.id, code: 'unknown-lane' })
  t.host({ type: 'subscribe-failed', id: lane.id, code: 'forbidden' })
  t.host({ type: 'subscribe-failed', id: 'stranger', code: 'too-many' })
  expect(terminalFrames).toEqual([
    { type: 'subscribe-failed', id: terminal.id, code: 'unknown-lane' },
  ])
  expect(laneFrames).toEqual([{ type: 'subscribe-failed', id: lane.id, code: 'forbidden' }])
  expect(t.connection.snapshot().lastError).toBeUndefined()
  t.host({ type: 'subscribe-failed', id: 'lanes', code: 'too-large' })
  expect(t.connection.snapshot().lastError).toBe('too-large')
  t.connection.close()
})

it('delivers terminal frames only for the subscribed terminal and matches acks by sequence', async () => {
  const t = await connect()
  expect(await t.connection.input(terminalId, 1, 'early')).toBe(false)
  t.ready()
  const frames: { type: string }[] = []
  const watch = t.connection.watchTerminal(terminalId, (f) => frames.push(f))
  const sub = t.socket().subscribes().at(-1)
  expect(sub).toEqual({ type: 'subscribe', id: expect.any(String), topic: 'terminal', terminalId })
  if (sub?.type !== 'subscribe') throw new Error('No terminal subscription')
  const output = {
    type: 'terminal.output',
    id: sub.id,
    terminalId,
    epoch: epochA,
    seq: 1,
    data: 'x',
  }
  t.host(output)
  t.host({ ...output, terminalId: '55555555-5555-4555-8555-555555555555' })
  t.host({ ...output, id: 'stranger' })
  t.host({ type: 'terminal.exit', id: sub.id, terminalId, epoch: epochA, seq: 2, exitCode: 0 })
  expect(frames.map((f) => f.type)).toEqual(['terminal.output', 'terminal.exit'])
  const first = t.connection.input(terminalId, 7, 'ls')
  expect(t.socket().sent.at(-1)).toEqual({ type: 'terminal.input', terminalId, seq: 7, data: 'ls' })
  expect(t.unrefTimer).toHaveBeenCalledTimes(1)
  expect(await t.connection.input(terminalId, 8, 'busy')).toBe(false)
  t.host({ type: 'terminal.ack', terminalId, seq: 6, accepted: true })
  t.host({ type: 'terminal.ack', terminalId, seq: 7, accepted: false })
  expect(await first).toBe(false)
  const second = t.connection.input(terminalId, 8, 'pwd')
  t.host({ type: 'terminal.ack', terminalId, seq: 8, accepted: true })
  expect(await second).toBe(true)
  let late: boolean | undefined
  void t.connection.input(terminalId, 9, 'slow').then((accepted) => {
    late = accepted
  })
  await vi.advanceTimersByTimeAsync(4999)
  expect(late).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(late).toBe(false)
  t.socket().full = true
  expect(await t.connection.input(terminalId, 10, 'full')).toBe(false)
  expect(t.socket().closes).toEqual([[1000, 'Transport failed']])
  watch.close()
  t.connection.close()
})

it('resubscribes lanes after its cursor, each watch at its cursor and each terminal', async () => {
  const t = await connect()
  const frames: LaneFrame[] = []
  const off = t.connection.watchLane(laneA, (f) => frames.push(f))
  expect(t.socket().subscribes()).toEqual([])
  t.ready()
  const terminal = t.connection.watchTerminal(terminalId, () => {})
  const [lanesSub, laneSub, terminalSub] = t.socket().subscribes()
  if (laneSub?.type !== 'subscribe' || terminalSub?.type !== 'subscribe') throw new Error('Subs')
  expect(lanesSub).toMatchObject({ id: 'lanes', topic: 'lanes' })
  expect(lanesSub).not.toHaveProperty('after')
  t.host(lanes(4))
  t.host(snapshot(laneSub.id, 8))
  const input = t.connection.input(terminalId, 1, 'ls')
  await t.reconnect()
  expect(await input).toBe(false)
  t.ready()
  expect(t.socket().subscribes()).toEqual([
    { type: 'subscribe', id: 'lanes', topic: 'lanes', after: cursor(4), trace: expect.any(String) },
    {
      type: 'subscribe',
      id: laneSub.id,
      topic: 'lane',
      laneId: laneA,
      after: cursor(8),
      trace: expect.any(String),
    },
    { type: 'subscribe', id: terminalSub.id, topic: 'terminal', terminalId },
  ])
  terminal.reset()
  expect(t.socket().subscribes().at(-1)).toEqual(t.socket().subscribes().at(-2))
  terminal.close()
  off()
  expect(t.socket().subscribes().slice(-2)).toEqual([
    { type: 'unsubscribe', id: terminalSub.id },
    { type: 'unsubscribe', id: laneSub.id },
  ])
  t.connection.close()
})

it('admits 63 lane watches but counts terminals against lane watches too', async () => {
  const t = await connect()
  t.ready()
  for (let i = 0; i < 62; i++) t.connection.watchLane(laneA, () => {})
  const terminal = t.connection.watchTerminal(terminalId, () => {})
  expect(() => t.connection.watchTerminal(terminalId, () => {})).toThrow(
    'Subscription unavailable.',
  )
  const last = t.connection.watchLane(laneA, () => {})
  expect(() => t.connection.watchLane(laneA, () => {})).toThrow('Subscription unavailable.')
  terminal.close()
  expect(() => t.connection.watchTerminal(terminalId, () => {})).toThrow(
    'Subscription unavailable.',
  )
  last()
  t.connection.watchTerminal(terminalId, () => {})
  t.connection.close()
  expect(() => t.connection.watchLane(laneA, () => {})).toThrow('Subscription unavailable.')
  expect(() => t.connection.watchTerminal(terminalId, () => {})).toThrow(
    'Subscription unavailable.',
  )
  expect(await t.connection.input(terminalId, 1, 'closed')).toBe(false)
})
