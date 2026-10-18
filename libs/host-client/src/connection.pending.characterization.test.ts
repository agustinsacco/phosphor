import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HOST_LIMITS,
  parseClientFrame,
  type ClientFrame,
  type FrameSocket,
} from '@phosphor/shared/host-protocol'
import { createHostConnection } from './connection'

// Characterization (DM-15): pending commands, ordered replay and calls, pinned
// through createHostConnection over a scripted socket before requests.ts moved
// to explicit state. Frozen: append cases, never edit these.
const hostId = '11111111-1111-4111-8111-111111111111'
const laneId = '22222222-2222-4222-8222-222222222222'
const terminalId = '33333333-3333-4333-8333-333333333333'
const endpoint = 'https://fixture.tail.ts.net:47615'

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
    runtimeEpoch: 'a'.repeat(16),
    capabilities: [],
  },
  proof: 'A'.repeat(86),
  connectionId: 'b'.repeat(16),
  grantExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  client: { id: hostId, label: 'Test' },
  capabilities: [],
})
const done = (requestId: string) => ({ type: 'receipt', receipt: { requestId, status: 'done' } })

/**
 * A transport the test drives by hand. The Host answers pings; the send queue
 * reads full after `allow` command or receipt-status writes.
 */
function scriptedSocket() {
  const sent: ClientFrame[] = []
  const closes: number[] = []
  let message: (text: string) => void = () => {}
  let closed: (code: number, reason: string) => void = () => {}
  const wire = {
    sent,
    closes,
    open: true,
    allow: Infinity,
    full: false,
    host: (frame: unknown) => message(JSON.stringify(frame)),
    drop(code: number) {
      if (!wire.open) return
      wire.open = false
      void Promise.resolve().then(() => closed(code, ''))
    },
    replayed: () => sent.filter((f) => f.type === 'command' || f.type === 'receipt-status'),
  }
  const socket: FrameSocket = {
    send(text) {
      const parsed = parseClientFrame(text)
      if (!parsed.ok) throw new Error(`Invalid client frame: ${parsed.reason}`)
      sent.push(parsed.frame)
      const frame = parsed.frame
      if (frame.type === 'ping')
        void Promise.resolve().then(() => wire.host({ type: 'pong', at: frame.at }))
      if ((frame.type === 'command' || frame.type === 'receipt-status') && --wire.allow <= 0)
        wire.full = true
    },
    close(code) {
      closes.push(code)
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
  const logs: unknown[][] = []
  const changed = vi.fn()
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
    unrefTimer,
    random: () => 1,
    log: (...args) => logs.push(args),
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
    logs,
    changed,
    unrefTimer,
    socket,
    ready: () => socket().host(readyFrame()),
    /** Severs the transport and waits out the first one-second backoff. */
    async reconnect(code = 1001) {
      socket().drop(code)
      await flush()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
    },
  }
}
const prompt = (message: string) => ({ type: 'prompt' as const, message })

it('replays pending commands in insertion order, retrying a full queue every 250ms', async () => {
  const t = await connect()
  t.ready()
  const results = [0, 1, 2].map((i) => t.connection.send(prompt(`Replay ${i}`), laneId, 1))
  const original = t.sockets[0]?.replayed() ?? []
  expect(original.map((f) => f.type)).toEqual(['command', 'command', 'command'])
  await t.reconnect()
  expect(t.sockets).toHaveLength(2)
  t.socket().allow = 1
  t.ready()
  expect(t.socket().sent.map((f) => f.type)).toEqual(['auth', 'subscribe', 'command'])
  expect(t.socket().replayed()).toEqual(original.slice(0, 1))
  expect(t.unrefTimer).toHaveBeenCalledTimes(1)
  expect(await t.connection.send({ type: 'abort' }, laneId, 1)).toMatchObject({
    status: 'not-sent',
    reason: 'not-connected',
  })
  await vi.advanceTimersByTimeAsync(250)
  expect(t.socket().replayed()).toEqual(original.slice(0, 1))
  t.socket().full = false
  t.socket().allow = 1
  await vi.advanceTimersByTimeAsync(250)
  expect(t.socket().replayed()).toEqual(original.slice(0, 2))
  t.socket().full = false
  t.socket().allow = Infinity
  const changes = t.changed.mock.calls.length
  await vi.advanceTimersByTimeAsync(250)
  expect(t.socket().replayed()).toEqual(original)
  expect(t.changed.mock.calls.length).toBe(changes + 1)
  for (const frame of original) if (frame.type === 'command') t.socket().host(done(frame.requestId))
  expect((await Promise.all(results)).map((r) => r.status)).toEqual(['done', 'done', 'done'])
  t.connection.close()
})

it.each([
  [59_999, 'command'],
  [60_000, 'receipt-status'],
])('rechecks the replay age on each attempt: %ims replays a %s', async (age, type) => {
  const t = await connect()
  t.ready()
  const sentAt = Date.now()
  const result = t.connection.send(prompt('Aged'), laneId, 1)
  const [command] = t.socket().replayed()
  if (command?.type !== 'command') throw new Error('No command')
  await t.reconnect()
  vi.setSystemTime(sentAt + age)
  t.ready()
  expect(t.socket().replayed()).toEqual([
    type === 'command' ? command : { type: 'receipt-status', requestId: command.requestId },
  ])
  t.socket().host(done(command.requestId))
  expect((await result).status).toBe('done')
  t.connection.close()
})

it('asks receipt-status at exactly 60000ms in flight and answers unknown, keeping it pending', async () => {
  const t = await connect()
  t.ready()
  let settled = ''
  void t.connection.send(prompt('Slow'), laneId, 1).then((r) => {
    settled = r.status
  })
  const [command] = t.socket().replayed()
  if (command?.type !== 'command') throw new Error('No command')
  await vi.advanceTimersByTimeAsync(59_999)
  expect(settled).toBe('')
  expect(t.socket().replayed()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe('unknown')
  expect(t.socket().replayed()).toEqual([
    command,
    { type: 'receipt-status', requestId: command.requestId },
  ])
  // The uncertain command still holds a pending slot and replays as a status query.
  await t.reconnect()
  t.ready()
  expect(t.socket().replayed()).toEqual([{ type: 'receipt-status', requestId: command.requestId }])
  t.connection.close()
})

it.each([1001, 1009, 4400])(
  'close %i decides whether replay resends or asks status',
  async (code) => {
    const t = await connect()
    t.ready()
    const result = t.connection.send(prompt('Severed'), laneId, 1)
    const [command] = t.socket().replayed()
    if (command?.type !== 'command') throw new Error('No command')
    await t.reconnect(code)
    t.ready()
    expect(t.socket().replayed()).toEqual([
      code === 1001 ? command : { type: 'receipt-status', requestId: command.requestId },
    ])
    t.socket().host(done(command.requestId))
    expect((await result).status).toBe('done')
    t.connection.close()
  },
)

it('refuses locally in admission order and never queues a not-sent command', async () => {
  const t = await connect()
  expect(await t.connection.send({ type: 'abort' }, laneId, 1)).toMatchObject({
    status: 'not-sent',
    reason: 'not-connected',
  })
  t.ready()
  const huge = prompt('x'.repeat(HOST_LIMITS.inboundFrameBytes))
  expect(await t.connection.send(huge, laneId, 1)).toMatchObject({ reason: 'too-large' })
  t.socket().full = true
  expect(await t.connection.send({ type: 'abort' }, laneId, 1)).toMatchObject({
    reason: 'not-connected',
  })
  expect(t.socket().closes).toEqual([1000])
  await flush()
  await vi.advanceTimersByTimeAsync(1000)
  await flush()
  expect(t.sockets).toHaveLength(2)
  t.ready()
  expect(t.socket().replayed()).toEqual([])
  const pending = Array.from({ length: 32 }, () => t.connection.send({ type: 'abort' }, laneId, 1))
  expect(await t.connection.send({ type: 'abort' }, laneId, 1)).toMatchObject({
    reason: 'too-many-pending',
  })
  expect(t.socket().replayed()).toHaveLength(32)
  t.connection.close()
  expect((await Promise.all(pending)).every((r) => r.status === 'unknown')).toBe(true)
  expect(await t.connection.send({ type: 'abort' }, laneId, 1)).toMatchObject({ reason: 'closed' })
  expect(await t.connection.send(huge, laneId, 1)).toMatchObject({ reason: 'too-large' })
})

it('finish settles commands unknown and calls closed, leaving no timer behind', async () => {
  const t = await connect()
  t.ready()
  const command = t.connection.send(prompt('Pending'), laneId, 1)
  const query = t.connection.call('host.repositories')
  t.connection.close()
  expect(await command).toMatchObject({ status: 'unknown' })
  expect(await query).toMatchObject({
    ok: false,
    error: { code: 'internal', message: 'Connection closed.' },
  })
  await flush()
  expect(vi.getTimerCount()).toBe(0)
})

it('times a call out at 30000ms, fails calls on disconnect and refuses when unready', async () => {
  const t = await connect()
  expect(await t.connection.call('host.repositories')).toMatchObject({
    ok: false,
    error: { message: 'Connection unavailable.' },
  })
  t.ready()
  let answer: unknown
  void t.connection.call('host.repositories').then((r) => {
    answer = r
  })
  await vi.advanceTimersByTimeAsync(29_999)
  expect(answer).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(answer).toMatchObject({
    ok: false,
    error: { code: 'internal', message: 'Query timed out.' },
  })
  const answered = t.connection.call('lane.state', { laneId })
  const call = t
    .socket()
    .sent.filter((f) => f.type === 'call')
    .at(-1)
  if (call?.type !== 'call') throw new Error('No call')
  t.socket().host({ type: 'result', id: call.id, ok: true, data: { fine: true } })
  expect(await answered).toEqual({ type: 'result', id: call.id, ok: true, data: { fine: true } })
  const severed = t.connection.call('host.repositories')
  t.socket().drop(1001)
  await flush()
  expect(await severed).toMatchObject({ ok: false, error: { message: 'Connection closed.' } })
  t.connection.close()
})

it('logs settled receipts except terminal operations and ignores pending receipts', async () => {
  const t = await connect()
  t.ready()
  const kill = t.connection.send({ type: 'terminal.kill', terminalId }, laneId, 1)
  const abort = t.connection.send({ type: 'abort' }, laneId, 1)
  const [killFrame, abortFrame] = t.socket().replayed()
  if (killFrame?.type !== 'command' || abortFrame?.type !== 'command')
    throw new Error('No commands')
  t.socket().host({
    type: 'receipt',
    receipt: { requestId: abortFrame.requestId, status: 'pending' },
  })
  t.socket().host(done(killFrame.requestId))
  t.socket().host(done(abortFrame.requestId))
  expect((await kill).status).toBe('done')
  expect((await abort).status).toBe('done')
  expect(t.logs.filter(([, message]) => message === 'receipt')).toEqual([
    ['hosts', 'receipt', { hostId, requestId: abortFrame.requestId, status: 'done' }],
  ])
  t.connection.close()
})
