import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import { decodeBase64url, encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import {
  HOST_LIMITS,
  helloProofMessage,
  parseHostFrame,
  type HostFrame,
} from '@phosphor/shared/host-protocol'
import {
  defineHostConformance,
  type HostConformanceFactory,
} from '@phosphor/shared/host-protocol-testing'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { createAuthority } from './authority'
import { createConnection, hostProof, type ConnectionPorts } from './connection'

export function fixture(limits: Parameters<HostConformanceFactory>[0] = {}) {
  const control = generateKeyPairSync('ed25519')
  const host = generateKeyPairSync('ed25519')
  const wrong = generateKeyPairSync('ed25519')
  const iat = Math.floor(Date.now() / 1000)
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'First viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: claims.epoch })
  const hello = {
    hostId: claims.hostId,
    hostVersion: 'test',
    protocolVersion: 1 as const,
    runtimeEpoch: randomBytes(8).toString('hex'),
    capabilities: [],
  }
  const connections = new Map<string, ReturnType<typeof createConnection>>()
  const logs: string[] = []
  const ready = vi.fn()
  const closed = vi.fn()
  const keyset = {
    get: vi.fn(async (kid: string) => (kid === claims.kid ? control.publicKey : undefined)),
  }
  const publicKey = decodeBase64url(host.publicKey.export({ format: 'jwk' }).x ?? '')
  if (!publicKey) throw new Error('Invalid generated key')
  function mintGrant(overrides: Partial<GrantPayload> = {}, badSignature = false) {
    return encodeGrant({ ...claims, ...overrides }, (bytes) =>
      sign(null, bytes, badSignature ? wrong.privateKey : control.privateKey),
    )
  }
  function connect(overrides: Partial<ConnectionPorts> = {}) {
    const pair = createLoopbackPair()
    const frames: HostFrame[] = []
    const codes: number[] = []
    pair.client.onMessage((text) => {
      const frame = parseHostFrame(text)
      if (!frame.ok) throw new Error('Invalid frame')
      frames.push(frame.value)
    })
    pair.client.onClose((code) => codes.push(code))
    const connection = createConnection({
      socket: pair.server,
      authority,
      keyset,
      origin: claims.iss,
      hello,
      key: host.privateKey,
      limits: Object.fromEntries(
        Object.entries(limits).filter(
          ([name, value]) =>
            ['authTimeoutMs', 'inboundFrameBytes', 'connectionsPerClient'].includes(name) &&
            value !== undefined,
        ),
      ),
      admit: (id) =>
        [...connections.values()].filter((c) => c.clientId() === id).length <
        (limits.connectionsPerClient ?? HOST_LIMITS.connectionsPerClient),
      log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
      onReady: ready,
      onClose: (id) => {
        closed(id)
        connections.delete(id)
      },
      ...overrides,
    })
    connections.set(connection.connectionId, connection)
    return { ...pair, socket: pair.client, frames, codes, connection }
  }
  const unavailable = () => {
    throw new Error('Lane scenario must be capability-filtered')
  }
  return {
    claims,
    authority,
    hello,
    host,
    control,
    keyset,
    logs,
    ready,
    closed,
    mintGrant,
    connect,
    publicKey,
    capabilities: [],
    requestId: randomUUID,
    signHelloProof: (hostId: string, runtimeEpoch: string, challenge: string) =>
      hostProof({ ...hello, hostId, runtimeEpoch }, challenge, host.privateKey),
    verifyProof: (ready: Extract<HostFrame, { type: 'ready' }>, challenge: string) => {
      const proof = decodeBase64url(ready.proof)
      return (
        ready.hello.hostId === claims.hostId &&
        proof !== null &&
        verify(
          null,
          Buffer.from(helloProofMessage(ready.hello.hostId, ready.hello.runtimeEpoch, challenge)),
          host.publicKey,
          proof,
        )
      )
    },
    driver: {
      emitTurn: unavailable,
      openDialog: unavailable,
      failLane: unavailable,
      emitUi: unavailable,
      restart: unavailable,
      executions: unavailable,
      revokeSession: (id: string) =>
        authority.accept({
          accepted: true,
          nextInSec: 30,
          revoked: { sessions: [id], clients: [] },
        }),
      revokeClient: (id: string) =>
        authority.accept({
          accepted: true,
          nextInSec: 30,
          revoked: { sessions: [], clients: [id] },
        }),
      stop: () => {
        for (const c of connections.values()) c.close(1001)
      },
    },
  }
}

defineHostConformance('real Host connection auth', fixture, { capabilities: [] })
const challenge = 'a'.repeat(64)
describe('connection boundary', () => {
  let h: ReturnType<typeof fixture>
  beforeEach(() => {
    vi.useFakeTimers()
    h = fixture()
  })
  afterEach(() => {
    h.driver.stop()
    vi.useRealTimers()
  })
  async function auth(overrides: Partial<GrantPayload> = {}, ports: Partial<ConnectionPorts> = {}) {
    const c = h.connect(ports)
    c.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(overrides), challenge }))
    await vi.advanceTimersByTimeAsync(0)
    return c
  }
  it.each(['issuer', 'lifetime', 'expired', 'future', 'unknown key'] as const)(
    'rejects %s with code only',
    async (kind) => {
      const now = h.claims.iat
      const overrides: Partial<GrantPayload> =
        kind === 'issuer'
          ? { iss: 'https://other.example' }
          : kind === 'lifetime'
            ? { exp: now + 301 }
            : kind === 'expired'
              ? { iat: now - 301, exp: now - CONTROL_LIMITS.signatureSkewSec }
              : kind === 'future'
                ? { iat: now + CONTROL_LIMITS.signatureSkewSec + 1, exp: now + 300 }
                : { kid: 'missing' }
      const code = kind === 'issuer' || kind === 'lifetime' ? 4403 : 4401
      const c = await auth(overrides)
      expect(c.codes).toEqual([code])
      expect(c.frames).toEqual([{ type: 'error', code, message: String(code) }])
    },
  )
  it('refuses broken tokens and first auth without a challenge', async () => {
    for (const frame of [
      { type: 'auth', grant: 'broken', challenge },
      { type: 'auth', grant: h.mintGrant() },
    ]) {
      const c = h.connect()
      c.socket.send(JSON.stringify(frame))
      await vi.advanceTimersByTimeAsync(0)
      expect(c.codes).toEqual([4401])
    }
  })
  it('supplies only authenticated parsed frames and effective caps to the handler hooks', async () => {
    const hooks = { handle: vi.fn(), renew: vi.fn(), close: vi.fn() }
    const handler = vi.fn(() => hooks)
    const hello = { ...h.hello, capabilities: ['sessions.read' as const] }
    const c = await auth({}, { hello, handler })
    expect(h.ready).toHaveBeenCalledWith(expect.objectContaining({ caps: ['sessions.read'] }))
    expect(handler).toHaveBeenCalledOnce()
    c.socket.send(JSON.stringify({ type: 'unsubscribe', id: 'topic' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.handle).toHaveBeenCalledWith({ type: 'unsubscribe', id: 'topic' }, [
      'sessions.read',
    ])
    c.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant({ caps: [] }) }))
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.renew).toHaveBeenCalledWith([])
    c.connection.close(1001)
    expect(hooks.close).toHaveBeenCalledOnce()
    const pending = h.connect({ handler })
    pending.socket.send(JSON.stringify({ type: 'unsubscribe', id: 'topic' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.codes).toEqual([4401])
    expect(handler).toHaveBeenCalledOnce()
  })
  it('serves no lane operations and records nothing', async () => {
    const c = await auth()
    expect(c.frames[0]).toMatchObject({
      type: 'ready',
      capabilities: [],
      hello: { capabilities: [] },
    })
    const requestId = randomUUID()
    const send = (value: unknown) => c.socket.send(JSON.stringify(value))
    send({ type: 'subscribe', id: 'lanes', topic: 'lanes' })
    send({ type: 'command', requestId, op: { type: 'abort' } })
    send({ type: 'call', id: 'state', method: 'lane.state' })
    send({ type: 'receipt-status', requestId })
    send({ type: 'ping', at: 10 })
    await vi.advanceTimersByTimeAsync(0)
    expect(c.frames.slice(1)).toEqual([
      { type: 'subscribe-failed', id: 'lanes', code: 'forbidden' },
      { type: 'receipt', receipt: { requestId, status: 'rejected', code: 'forbidden' } },
      {
        type: 'result',
        id: 'state',
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      },
      { type: 'receipt', receipt: { requestId, status: 'unknown' } },
      { type: 'pong', at: 10 },
    ])
    expect(h.ready).toHaveBeenCalledOnce()
  })
  it.each(['owner', 'epoch', 'removed'] as const)(
    'closes all sockets on %s change',
    async (kind) => {
      const a = await auth()
      const b = await auth({ client: { id: randomUUID(), label: 'Other' } })
      const pending = h.connect()
      if (kind === 'removed') h.authority.remove()
      else
        h.authority.accept({
          accepted: true,
          nextInSec: 30,
          ...(kind === 'owner' ? { ownerId: randomUUID() } : { epoch: 2 }),
        })
      await vi.advanceTimersByTimeAsync(0)
      expect([a.codes, b.codes, pending.codes]).toEqual([[4403], [4403], [4403]])
    },
  )
  it('revokes only the named session or client and missing fields do not clear it', async () => {
    const a = await auth()
    const b = await auth({ sid: randomUUID(), client: { id: randomUUID(), label: 'Other' } })
    h.driver.revokeSession(h.claims.sid)
    h.authority.accept({ accepted: true, nextInSec: 30 })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.codes).toEqual([4403])
    expect(b.codes).toEqual([])
    expect((await auth()).codes).toEqual([4403])
  })
  it('does not leak credentials or proofs in logs, including failures', async () => {
    const c = await auth()
    c.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant({}, true) }))
    await vi.advanceTimersByTimeAsync(0)
    const ready = c.frames[0]
    if (!ready || ready.type !== 'ready') throw new Error('Missing ready')
    for (const secret of [
      challenge,
      h.mintGrant(),
      ready.proof,
      h.claims.jti,
      h.claims.sid,
      h.claims.sub,
    ])
      expect(h.logs.join('\n')).not.toContain(secret)
    for (const line of h.logs) {
      const entry: unknown = JSON.parse(line)
      if (!entry || typeof entry !== 'object') throw new Error('Invalid log')
      expect(
        Object.keys(entry).every((key) =>
          ['event', 'connectionId', 'clientId', 'reason', 'code', 'ms'].includes(key),
        ),
      ).toBe(true)
    }
    expect(h.closed).toHaveBeenCalledOnce()
  })
  it('bounds verification concurrency and ignores a result after close', async () => {
    let resolve: (key: typeof h.control.publicKey) => void = () => {}
    const c = h.connect({
      keyset: {
        get: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
    })
    const frame = JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge })
    c.socket.send(frame)
    await vi.advanceTimersByTimeAsync(0)
    c.socket.send(frame)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.codes).toEqual([4429])
    resolve(h.control.publicKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ready).not.toHaveBeenCalled()
  })
  it('bounds outbound queues and closes idle clients', async () => {
    const c = await auth()
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.idleCloseMs - 1)
    expect(c.socket.isOpen()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.codes).toEqual([4401])
    const pair = createLoopbackPair()
    const blocked = await auth(
      {},
      { socket: { ...pair.server, bufferedBytes: () => HOST_LIMITS.sendQueueBytes } },
    )
    expect(blocked.connection.clientId()).toBeUndefined()
    pair.client.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.at(-1)).toContain('4429')
  })
})

it('resets the text-frame idle deadline, bounds UTF-8 bytes, and rejects renewal challenges', async () => {
  vi.useFakeTimers()
  const h = fixture({ inboundFrameBytes: 2048 })
  try {
    const c = h.connect({
      limits: { inboundFrameBytes: 2048, idleCloseMs: 100, pingIntervalMs: 10 },
    })
    c.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(99)
    const ping = JSON.stringify({ type: 'ping', at: 1 }).padEnd(2048, ' ')
    c.socket.send(ping)
    await vi.advanceTimersByTimeAsync(99)
    expect(c.socket.isOpen()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.codes).toEqual([4401])
    const next = h.connect()
    next.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(0)
    next.socket.send(ping + ' ')
    await vi.advanceTimersByTimeAsync(0)
    expect(next.codes).toEqual([4400])
    const renewal = h.connect()
    renewal.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(0)
    renewal.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(0)
    expect(renewal.codes).toEqual([4403])
  } finally {
    h.driver.stop()
    vi.useRealTimers()
  }
})

it('bounds first-frame arrival separately from a bounded keyset refresh', async () => {
  vi.useFakeTimers()
  const h = fixture()
  try {
    const silent = h.connect()
    const delayed = h.connect({
      keyset: {
        get: () => new Promise((resolve) => setTimeout(() => resolve(h.control.publicKey), 2000)),
      },
    })
    await vi.advanceTimersByTimeAsync(9000)
    delayed.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(silent.codes).toEqual([4401])
    expect(delayed.socket.isOpen()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(delayed.frames[0]?.type).toBe('ready')
    expect(delayed.codes).toEqual([])
  } finally {
    h.driver.stop()
    vi.useRealTimers()
  }
})

it('logs the connection trace on open and close without identities or credentials', async () => {
  const f = fixture()
  const c = f.connect()
  const token = f.mintGrant()
  const trace = '0123456789abcdef'
  c.socket.send(JSON.stringify({ type: 'auth', grant: token, challenge: 'a'.repeat(64), trace }))
  for (let i = 0; i < 30; i++) await Promise.resolve()
  c.connection.close(1001)
  const events = f.logs.map((line) => JSON.parse(line))
  expect(events).toEqual([
    { event: 'api.connected', trace },
    { event: 'api.closed', trace, code: 1001, ms: expect.any(Number) },
  ])
  for (const event of events)
    for (const value of Object.values(event))
      expect(String(value)).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  for (const secret of [token, f.claims.client.id, f.claims.hostId, c.connection.connectionId])
    expect(f.logs.join('\n')).not.toContain(secret)
})
