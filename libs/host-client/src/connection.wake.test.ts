import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import { createHostConnection, WAKE_PROBE_MS } from './connection'
import { browserCrypto } from './crypto'

/** A phone that slept: the page comes back with its socket dead or its retry far away. */
const hostId = '11111111-1111-4111-8111-111111111111'
const endpoint = 'https://fixture.tail.ts.net:47615'
const ready = JSON.stringify({
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
  grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
  client: { id: hostId, label: 'Test' },
  capabilities: [],
})

interface Fake {
  sent: { type: string }[]
  message: (text: string) => void
  drop: (code: number) => void
  closedBy: string[]
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const sockets: Fake[] = []
  let offline = false
  const opened = vi.fn(async () => {
    if (offline) throw new Error('offline')
    let open = true
    let onClose: (code: number, reason: string) => void = () => {}
    const fake: Fake = { sent: [], message: () => {}, drop: () => {}, closedBy: [] }
    fake.drop = (code) => {
      open = false
      onClose(code, '')
    }
    sockets.push(fake)
    const socket: FrameSocket = {
      send: (text) => void fake.sent.push(JSON.parse(text)),
      close: (code, reason) => {
        fake.closedBy.push(reason)
        queueMicrotask(() => fake.drop(code))
      },
      onMessage: (cb) => (fake.message = cb),
      onClose: (cb) => (onClose = cb),
      isOpen: () => open,
      bufferedBytes: () => 0,
    }
    return socket
  })
  const connection = createHostConnection({
    hostId,
    endpoint,
    identity: { ...browserCrypto, verify: async () => true },
    socket: opened,
    grant: async () => ({
      grant: 'fixture',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      host: { id: hostId, endpoint, publicKey: 'fixture' },
    }),
    clearGrant: () => {},
    random: () => 1,
    changed: () => {},
  })
  const last = () => sockets[sockets.length - 1]!
  return {
    connection,
    opened,
    last,
    setOffline: (value: boolean) => (offline = value),
    async handshake(capabilities: string[] = []) {
      await vi.advanceTimersByTimeAsync(0)
      const frame = JSON.parse(ready)
      last().message(
        JSON.stringify({ ...frame, hello: { ...frame.hello, capabilities }, capabilities }),
      )
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

it('retries at once when the page wakes instead of waiting out the backoff', async () => {
  const t = setup()
  try {
    await t.handshake()
    expect(t.connection.snapshot().state).toBe('ready')
    // The phone sleeps: the socket drops, and every retry fails while offline.
    t.setOffline(true)
    t.last().drop(1006)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000)
    expect(t.opened).toHaveBeenCalledTimes(4)
    expect(t.connection.snapshot().state).toBe('reconnecting')
    // Back online, the next scheduled try is 8s away. Waking does not wait for it.
    t.setOffline(false)
    t.connection.wake()
    await t.handshake()
    expect(t.opened).toHaveBeenCalledTimes(5)
    expect(t.connection.snapshot().state).toBe('ready')
  } finally {
    t.connection.close()
  }
})

it('probes a socket that looks open after a wake and replaces it when no pong returns', async () => {
  const t = setup()
  try {
    await t.handshake()
    const sleeping = t.last()
    await vi.advanceTimersByTimeAsync(5000)
    t.connection.wake()
    expect(sleeping.sent.at(-1)?.type).toBe('ping')
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MS)
    expect(sleeping.closedBy).toEqual(['Wake timeout'])
    expect(t.connection.snapshot().state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.opened).toHaveBeenCalledTimes(2)
  } finally {
    t.connection.close()
  }
})

it('keeps a live socket that answers the wake probe', async () => {
  const t = setup()
  try {
    await t.handshake()
    t.connection.wake()
    t.last().message(JSON.stringify({ type: 'pong', at: Date.now() }))
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MS)
    expect(t.last().closedBy).toEqual([])
    expect(t.connection.snapshot().state).toBe('ready')
    expect(t.opened).toHaveBeenCalledTimes(1)
  } finally {
    t.connection.close()
  }
})

it('does not wake through a rate limit, and stays closed after sign-out', async () => {
  const t = setup()
  try {
    await t.handshake()
    t.last().drop(4429)
    t.connection.wake()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(t.opened).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.opened).toHaveBeenCalledTimes(2)
  } finally {
    t.connection.close()
  }
  t.connection.wake()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(t.opened).toHaveBeenCalledTimes(2)
  expect(t.connection.snapshot().state).toBe('signed-out')
})

/*
 * A local service restarting accepts the socket before its lanes start and grants nothing,
 * then closes 1001 and reconnects with its capabilities. A command pending across the
 * restart waits for that connection instead of replaying into a definite refusal.
 */
it('holds a pending command through a ready that grants nothing, then replays it once', async () => {
  const caps = ['sessions.read', 'sessions.control']
  const commands = (socket: Fake) =>
    socket.sent.filter((f): f is { type: 'command'; requestId: string } => f.type === 'command')
  const t = setup()
  try {
    await t.handshake(caps)
    const sending = t.connection.send({ type: 'prompt', message: 'hi' }, hostId, 1)
    const [sent] = commands(t.last())
    expect(sent).toBeDefined()
    t.last().drop(1001)
    await vi.advanceTimersByTimeAsync(1000)
    await t.handshake([])
    const booting = t.last()
    // The booting service refuses whatever reaches it before its lanes start.
    for (const frame of commands(booting))
      booting.message(
        JSON.stringify({
          type: 'receipt',
          receipt: { requestId: frame.requestId, status: 'rejected', code: 'forbidden' },
        }),
      )
    await vi.advanceTimersByTimeAsync(0)
    expect(commands(booting)).toEqual([])
    booting.drop(1001)
    await vi.advanceTimersByTimeAsync(1000)
    await t.handshake(caps)
    expect(commands(t.last()).map((f) => f.requestId)).toEqual([sent!.requestId])
    t.last().message(
      JSON.stringify({ type: 'receipt', receipt: { requestId: sent!.requestId, status: 'done' } }),
    )
    expect(await sending).toMatchObject({ status: 'done' })
  } finally {
    t.connection.close()
  }
})
