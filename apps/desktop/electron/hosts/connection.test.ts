import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeHost, createLoopbackPair } from '@shared/host-protocol-testing'
import {
  HOST_LIMITS,
  helloProofMessage,
  parseClientFrame,
  parseHostFrame,
  utf8Length,
  type ClientFrame,
} from '@shared/host-protocol'
import type { GrantPayload } from '@shared/host-grant'
import { createHostConnection, type LaneFrame } from './connection'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
async function setup(
  options: { wrongKey?: boolean; wrongId?: boolean; endpoint?: string; delay?: number } = {},
) {
  const keys = generateKeyPairSync('ed25519')
  const wrong = generateKeyPairSync('ed25519')
  const hostId = randomUUID(),
    clientId = randomUUID()
  let laneId: string = randomUUID()
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId,
    epoch: 1,
    client: { id: clientId, label: 'Viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const host = createFakeHost({
    expectations: { iss: claims.iss, hostId, owner: claims.sub, epoch: 1 },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    verify: () => true,
    verifyGrant: () => ({
      ...claims,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    sign: (bytes) => sign(null, bytes, keys.privateKey),
    commandDelayMs: options.delay,
  })
  // Only the fake owns lane contents, and all paths are fictional.
  const frames: ClientFrame[] = [],
    logs: unknown[] = []
  const proofs: string[] = []
  let initialAuth: Extract<ClientFrame, { type: 'auth' }> | undefined
  const pairs: ReturnType<typeof createLoopbackPair>[] = []
  const endpoint = options.endpoint ?? 'https://bee.tail.ts.net:47615'
  const publicKey = (options.wrongKey ? wrong : keys).publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('Missing test key')
  const token = randomBytes(32).toString('hex')
  const grant = vi.fn(async () => ({
    grant: token,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    host: { id: hostId, publicKey, endpoint },
  }))
  const clearGrant = vi.fn()
  const socket = vi.fn(async () => {
    const pair = createLoopbackPair()
    pairs.push(pair)
    pair.server.onMessage((text) => {
      const parsed = parseClientFrame(text)
      if (parsed.ok) {
        frames.push(parsed.frame)
        if (parsed.frame.type === 'auth') initialAuth = parsed.frame
      }
    })
    host.attach(pair.server)
    return {
      ...pair.client,
      onMessage: (cb: (text: string) => void) =>
        pair.client.onMessage((text) => {
          const parsed = parseHostFrame(text)
          if (parsed.ok && parsed.value.type === 'ready') proofs.push(parsed.value.proof)
          if (options.wrongId && parsed.ok && parsed.value.type === 'ready') {
            const f = parsed.value,
              impostor = randomUUID()
            const proof = sign(
              null,
              Buffer.from(
                helloProofMessage(impostor, f.hello.runtimeEpoch, initialAuth?.challenge ?? ''),
              ),
              keys.privateKey,
            ).toString('base64url')
            cb(JSON.stringify({ ...f, hello: { ...f.hello, hostId: impostor }, proof }))
          } else cb(text)
        }),
    }
  })
  const connection = createHostConnection({
    hostId,
    endpoint,
    socket,
    grant,
    clearGrant,
    changed: () => {},
    random: () => 1,
    log: (...args) => logs.push(args),
  })
  await drain()
  if (connection.snapshot().state === 'ready') {
    const created = connection.send({
      type: 'lane.create',
      repositoryId: '0123456789abcdef',
      worktree: null,
    })
    await drain()
    const receipt = await created
    if (receipt.status !== 'done' || !receipt.laneId) throw new Error('No lane')
    laneId = receipt.laneId
    frames.length = 0
  }
  return {
    connection,
    host,
    grant,
    socket,
    pairs,
    frames,
    logs,
    token,
    initialAuth,
    proofs,
    clientId,
    laneId,
    clearGrant,
  }
}

it('authenticates, queries, lists deltas, watches in order, and keeps secrets out of logs', async () => {
  const t = await setup()
  await drain()
  expect(t.connection.snapshot().state).toBe('ready')
  expect(t.connection.snapshot().lanes).toHaveLength(1)
  expect(t.socket).toHaveBeenCalledWith('wss://bee.tail.ts.net:47615/v1/stream')
  const events: LaneFrame[] = []
  const off = t.connection.watchLane(t.laneId, (frame) => events.push(frame))
  await drain()
  const result = t.connection.call('host.repositories')
  await drain()
  expect((await result).ok).toBe(true)
  const receipt = t.connection.send(
    { type: 'set_session_name', name: 'Private title' },
    t.laneId,
    1,
  )
  await drain()
  await vi.advanceTimersByTimeAsync(1)
  expect((await receipt).status).toBe('done')
  expect(t.connection.snapshot().lanes[0]?.title).toBe('Private title')
  expect(events[0]?.type).toBe('snapshot')
  const sequences = events.filter((e) => e.type === 'event').map((e) => e.cursor.seq)
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
  const auth = t.initialAuth
  if (!auth || auth.type !== 'auth' || !auth.challenge) throw new Error('Missing auth')
  expect(t.proofs).toHaveLength(1)
  const readyLogs = JSON.stringify(t.logs)
  for (const secret of [t.token, auth.challenge, ...t.proofs, 'Private title'])
    expect(readyLogs).not.toContain(secret)
  off()
  t.connection.close()
  t.host.stop()
})

it.each([{ wrongKey: true }, { wrongId: true }])(
  'never trusts a failed proof or later frames: %j',
  async (options) => {
    const t = await setup(options)
    await drain()
    expect(t.connection.snapshot()).toMatchObject({
      state: 'wrong-machine',
      capabilities: [],
      lanes: [],
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.socket).toHaveBeenCalledTimes(1)
    t.connection.close()
    t.host.stop()
  },
)
it.each([
  'http://bee.tail.ts.net',
  'https://example.com',
  'https://bee.ts.net/path',
  'https://bee.ts.net@evil.com',
  'https://bee.ts.net?x=1',
])('never opens a non-origin or non-tailnet endpoint %s', async (endpoint) => {
  const t = await setup({ endpoint })
  await drain()
  expect(t.connection.snapshot().state).toBe('no-address')
  expect(t.socket).not.toHaveBeenCalled()
  t.connection.close()
  t.host.stop()
})

it('renews before expiry, keeps pings flowing, and stops on revocation', async () => {
  const t = await setup()
  await drain()
  await vi.advanceTimersByTimeAsync(240_000)
  await drain()
  expect(t.grant).toHaveBeenCalledTimes(2)
  expect(t.frames.some((f) => f.type === 'auth' && !f.challenge)).toBe(true)
  expect(t.frames.filter((f) => f.type === 'ping')).toHaveLength(12)
  expect(t.connection.snapshot().state).toBe('ready')
  t.host.revokeClient(t.clientId)
  await drain()
  expect(t.connection.snapshot().lastError).toBe('forbidden')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(t.socket).toHaveBeenCalledTimes(1)
  t.connection.close()
  t.host.stop()
})

it.each([1001, 1009, 4400])('resumes a severed command safely for close %s', async (code) => {
  const t = await setup({ delay: 1500 })
  await drain()
  const result = t.connection.send({ type: 'prompt', message: 'Private prompt' }, t.laneId, 1)
  await drain()
  t.pairs[0]?.client.close(code, 'Sever')
  await drain()
  await vi.advanceTimersByTimeAsync(2000)
  await drain()
  expect((await result).status).toBe('done')
  const commands = t.frames.filter((f) => f.type === 'command')
  expect(commands).toHaveLength(code === 1001 ? 2 : 1)
  if (code === 1001) expect(commands[0]).toEqual(commands[1])
  else expect(t.frames.some((f) => f.type === 'receipt-status')).toBe(true)
  expect(t.host.executions()).toBe(1)
  t.connection.close()
  t.host.stop()
})

it('uses receipt-status, not a resend, at exactly 60 seconds', async () => {
  const t = await setup({ delay: 1500 })
  await drain()
  const result = t.connection.send({ type: 'prompt', message: 'Delayed' }, t.laneId, 1)
  await drain()
  t.pairs[0]?.client.close(1001, 'Sever')
  await drain()
  vi.setSystemTime(Date.now() + 59_000)
  await vi.advanceTimersByTimeAsync(2000)
  await drain()
  expect(t.frames.filter((f) => f.type === 'command')).toHaveLength(1)
  expect(t.frames.some((f) => f.type === 'receipt-status')).toBe(true)
  expect((await result).status).toBe('done')
  t.connection.close()
  t.host.stop()
})

it('retains older replay once, keeps the max cursor, and resets on a new epoch', async () => {
  const t = await setup()
  await drain()
  const events: LaneFrame[] = []
  t.connection.watchLane(t.laneId, (f) => events.push(f))
  await drain()
  t.host.openDialog(t.laneId)
  await drain()
  const old = t.connection.attention()[0]
  if (!old) throw new Error('Missing attention')
  t.pairs[0]?.client.close(1001, 'Sever')
  await drain()
  t.host.failLane(t.laneId)
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(
    t.frames.filter((f) => f.type === 'subscribe' && f.topic === 'lanes').at(-1),
  ).toMatchObject({ after: old.cursor })
  expect(t.connection.attention()).toHaveLength(2)
  const cursor = t.connection.snapshot().cursor
  expect(cursor?.seq).toBeGreaterThan(old.cursor.seq)
  t.pairs.at(-1)?.server.send(JSON.stringify(old))
  await drain()
  expect(t.connection.attention()).toHaveLength(2)
  expect(t.connection.snapshot().cursor).toEqual(cursor)
  t.host.restart()
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.connection.attention()).toHaveLength(0)
  expect(events.filter((f) => f.type === 'snapshot').at(-1)).toMatchObject({ reset: true })
  t.connection.close()
  t.host.stop()
})

it('caps attention at 50 and rejects another epoch', async () => {
  const t = await setup()
  await drain()
  for (let i = 0; i < 51; i++) t.host.failLane(t.laneId)
  await drain()
  expect(t.connection.attention()).toHaveLength(50)
  const old = t.connection.attention()[0]
  if (!old) throw new Error('Missing attention')
  t.pairs[0]?.server.send(
    JSON.stringify({ ...old, cursor: { epoch: 'ffffffffffffffff', seq: 999 } }),
  )
  await drain()
  expect(t.connection.attention()).toHaveLength(50)
  expect(t.connection.snapshot().cursor?.seq).not.toBe(999)
  t.connection.close()
  t.host.stop()
})

it('bounds commands, local oversize refusals, queries and subscriptions', async () => {
  const t = await setup({ delay: 1500 })
  await drain()
  const before = t.frames.length
  expect(
    await t.connection.send(
      { type: 'prompt', message: 'x'.repeat(HOST_LIMITS.inboundFrameBytes) },
      t.laneId,
      1,
    ),
  ).toMatchObject({ status: 'not-sent', reason: 'too-large' })
  expect(t.frames).toHaveLength(before)
  const pending = Array.from({ length: 32 }, () =>
    t.connection.send({ type: 'abort' }, t.laneId, 1),
  )
  expect(await t.connection.send({ type: 'abort' }, t.laneId, 1)).toMatchObject({
    reason: 'too-many-pending',
  })
  for (let i = 0; i < 63; i++) t.connection.watchLane(t.laneId, () => {})
  expect(() => t.connection.watchLane(t.laneId, () => {})).toThrow('Subscription unavailable')
  t.connection.close()
  await Promise.all(pending)
  expect(await t.connection.send({ type: 'abort' }, t.laneId, 1)).toMatchObject({
    reason: 'closed',
  })
  t.host.stop()
})

it.each([4401, 4409, 4429])('handles retry policy for %s', async (code) => {
  const t = await setup()
  await drain()
  t.pairs[0]?.client.close(code, 'Closed')
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.socket).toHaveBeenCalledTimes(code === 4401 ? 2 : 1)
  if (code === 4401) expect(t.clearGrant).toHaveBeenCalledTimes(1)
  if (code === 4409) expect(t.connection.snapshot().state).toBe('unsupported')
  if (code === 4429) {
    await vi.advanceTimersByTimeAsync(29_000)
    await drain()
    expect(t.socket).toHaveBeenCalledTimes(2)
  }
  t.connection.close()
  t.host.stop()
})

it('closes on bad frames, misses two pongs, and times out queries', async () => {
  const t = await setup()
  await drain()
  t.pairs[0]?.server.send('not json')
  await drain()
  expect(t.connection.snapshot().state).toBe('reconnecting')
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  t.pairs.at(-1)?.dropNext(100)
  const result = t.connection.call('lane.stats', { laneId: t.laneId })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toMatchObject({ ok: false, error: { message: 'Query timed out.' } })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.connection.snapshot().state).toBe('reconnecting')
  t.connection.close()
  t.host.stop()
})

it('asks status after an epoch crash and returns unknown without repeating the action', async () => {
  const t = await setup({ delay: 1500 })
  const result = t.connection.send({ type: 'prompt', message: 'Crash' }, t.laneId, 1)
  await drain()
  t.host.restart()
  await drain()
  vi.setSystemTime(Date.now() + 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect((await result).status).toBe('unknown')
  expect(t.frames.filter((f) => f.type === 'command')).toHaveLength(1)
  t.connection.close()
  t.host.stop()
})

it('recovers a lane event gap and applies summary removals', async () => {
  const t = await setup()
  const received: LaneFrame[] = []
  t.connection.watchLane(t.laneId, (f) => received.push(f))
  await drain()
  const first = received[0]
  if (!first || first.type !== 'snapshot') throw new Error('No snapshot')
  t.pairs[0]?.server.send(
    JSON.stringify({
      type: 'event',
      id: first.id,
      laneId: t.laneId,
      cursor: { ...first.snapshot.cursor, seq: 99 },
      event: { kind: 'control', control: first.snapshot.summary.control },
    }),
  )
  await drain()
  expect(received.some((f) => f.type === 'event' && f.cursor.seq === 99)).toBe(false)
  expect(t.frames.filter((f) => f.type === 'subscribe' && f.topic === 'lane')).toHaveLength(2)
  const cursor = t.connection.snapshot().cursor
  if (!cursor) throw new Error('No cursor')
  t.pairs[0]?.server.send(
    JSON.stringify({
      type: 'lanes-delta',
      id: 'lanes',
      cursor: { ...cursor, seq: cursor.seq + 1 },
      upsert: [],
      remove: [t.laneId],
    }),
  )
  await drain()
  expect(t.connection.snapshot().lanes).toHaveLength(0)
  t.connection.close()
  expect(t.connection.attention()).toHaveLength(0)
  expect(t.connection.snapshot().lanes).toHaveLength(0)
  t.host.stop()
})

it('refuses transient and permanently closed sends locally, without recording or resending', async () => {
  const t = await setup()
  t.pairs[0]?.client.close(1001, 'Sever')
  await drain()
  expect(await t.connection.send({ type: 'abort' }, t.laneId, 1)).toMatchObject({
    status: 'not-sent',
    reason: 'not-connected',
  })
  expect(t.frames.filter((f) => f.type === 'command')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.frames.filter((f) => f.type === 'command' || f.type === 'receipt-status')).toHaveLength(
    0,
  )
  t.host.revokeClient(t.clientId)
  await drain()
  expect(await t.connection.send({ type: 'abort' }, t.laneId, 1)).toMatchObject({
    reason: 'closed',
  })
  t.connection.close()
  expect(await t.connection.send({ type: 'abort' }, t.laneId, 1)).toMatchObject({
    reason: 'closed',
  })
  t.host.stop()
})

it('accepts exactly the frame byte limit and refuses one byte past it', async () => {
  const t = await setup({ delay: 1500 })
  const overhead = utf8Length(
    JSON.stringify({
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'prompt', message: '' },
      laneId: t.laneId,
      fence: 1,
      trace: randomBytes(8).toString('hex'),
    }),
  )
  const message = 'x'.repeat(HOST_LIMITS.inboundFrameBytes - overhead)
  const accepted = t.connection.send({ type: 'prompt', message }, t.laneId, 1)
  await drain()
  const frame = t.frames.find((f) => f.type === 'command')
  expect(utf8Length(JSON.stringify(frame))).toBe(HOST_LIMITS.inboundFrameBytes)
  expect(
    await t.connection.send({ type: 'prompt', message: message + 'x' }, t.laneId, 1),
  ).toMatchObject({ reason: 'too-large' })
  await drain()
  expect(t.frames.filter((f) => f.type === 'command')).toHaveLength(1)
  t.connection.close()
  await accepted
  t.host.stop()
})
