import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeBase64url,
  encodeGrant,
  grantUtf8,
  type GrantClient,
  type GrantPayload,
} from '../../host-grant'
import {
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type ClientFrame,
  type HostFrame,
} from '../../host-protocol'
import { createFakeHost, type FakeHostOptions } from '../fake-host'
import { createLoopbackPair } from '../loopback'
import {
  admitIdentity,
  authenticate,
  authorized,
  ready,
  reconnectControllers,
  scheduleExpiry,
  verifiedGrant,
} from './auth'
import { createFakeHostState, type Connection, type FakeHostState, type Lane } from './state'

const ISSUER = 'https://control.test'
const HOST_ID = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000a2'
const SESSION = '00000000-0000-4000-8000-0000000000a3'
const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }
const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/test/repository' }
const LANE = '00000000-0000-4000-8000-000000000001'
const CHALLENGE = 'c'.repeat(64)
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const SECONDS = T0 / 1000
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const hosts: ReturnType<typeof createFakeHost>[] = []

function payload(overrides: Partial<GrantPayload> = {}): GrantPayload {
  const iat = Math.floor(Date.now() / 1000)
  return {
    v: 1,
    iss: ISSUER,
    kid: 'test-key',
    sub: OWNER,
    sid: SESSION,
    hostId: HOST_ID,
    epoch: 1,
    client: FIRST,
    caps: ['sessions.read', 'sessions.control'],
    iat,
    exp: iat + 300,
    jti: '0123456789abcdef',
    ...overrides,
  }
}
const grant = (overrides: Partial<GrantPayload> = {}, signatureByte = 7) =>
  encodeGrant(payload(overrides), () => new Uint8Array(64).fill(signatureByte))

/** Signing is injected: verify accepts all-7 signatures, sign returns all-9 bytes. */
function harness(extra: Partial<FakeHostOptions> = {}) {
  let epochs = 0
  const verified: string[] = [],
    signed: string[] = []
  const host = createFakeHost({
    expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
    verify: (bytes, signature, kid) => {
      verified.push(`${kid}:${signature[0]}:${new TextDecoder().decode(bytes)}`)
      return signature.every((b) => b === 7)
    },
    sign: (bytes) => {
      signed.push(new TextDecoder().decode(bytes))
      return new Uint8Array(64).fill(9)
    },
    id: () => LANE,
    epoch: () => `epoch-${++epochs}`,
    repositories: [REPOSITORY],
    ...extra,
  })
  hosts.push(host)
  function connect() {
    const pair = createLoopbackPair()
    const frames: HostFrame[] = [],
      closes: string[] = []
    pair.client.onMessage((text) => frames.push(JSON.parse(text)))
    pair.client.onClose((code, reason) => closes.push(`${code} ${reason}`))
    host.attach(pair.server)
    const send = (frame: ClientFrame) => pair.client.send(JSON.stringify(frame))
    return {
      pair,
      frames,
      closes,
      send,
      auth: (token: string, challenge: string | null = CHALLENGE) =>
        send({ type: 'auth', grant: token, ...(challenge === null ? {} : { challenge }) }),
      types: () => frames.map((f) => f.type),
    }
  }
  return { host, verified, signed, connect }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  await flush()
  vi.useRealTimers()
})

describe('authentication through createFakeHost', () => {
  it('verifies the signed payload bytes with the grant kid, or defers wholly to verifyGrant', async () => {
    const h = harness()
    const good = h.connect(),
      forged = h.connect(),
      garbled = h.connect()
    good.auth(grant())
    forged.auth(grant({}, 8))
    garbled.auth('not-a-grant')
    await flush()
    expect(good.types()).toEqual(['ready'])
    expect([forged.closes, garbled.closes]).toEqual([
      ['4401 Invalid grant'],
      ['4401 Invalid grant'],
    ])
    expect(h.verified).toEqual([
      `test-key:7:${JSON.stringify(payload())}`,
      `test-key:8:${JSON.stringify(payload())}`,
    ])
    const tokens = new Map([['good', payload()]])
    const custom = harness({ verifyGrant: (token) => tokens.get(token) ?? null })
    const accepted = custom.connect(),
      refused = custom.connect()
    accepted.auth('good')
    refused.auth(grant())
    await flush()
    expect([accepted.types(), refused.closes, custom.verified]).toEqual([
      ['ready'],
      ['4401 Invalid grant'],
      [],
    ])
  })

  it('refuses claims with 4401 for time and 4403 for identity or revocation, at the skew edges', async () => {
    const h = harness()
    const cases: [string, Partial<GrantPayload>][] = [
      ['issuer', { iss: 'https://other.test' }],
      ['host', { hostId: SESSION }],
      ['owner', { sub: SESSION }],
      ['epoch', { epoch: 2 }],
      ['lifetime', { iat: SECONDS, exp: SECONDS + 301 }],
      ['early edge', { iat: SECONDS + 60, exp: SECONDS + 360 }],
      ['early', { iat: SECONDS + 61, exp: SECONDS + 361 }],
      ['late edge', { iat: SECONDS - 299, exp: SECONDS - 59 }],
      ['late', { iat: SECONDS - 300, exp: SECONDS - 60 }],
    ]
    const outcomes: string[] = []
    for (const [name, claims] of cases) {
      const v = h.connect()
      v.auth(grant(claims))
      await flush()
      outcomes.push(`${name}: ${v.closes.join(',') || v.types().join(',')}`)
    }
    h.host.revokeSession(SESSION)
    const session = h.connect()
    session.auth(grant())
    h.host.revokeClient(SECOND.id)
    const client = h.connect()
    client.auth(grant({ client: SECOND, sid: OWNER }))
    await flush()
    outcomes.push(`revoked: ${session.closes.join(',')} ${client.closes.join(',')}`)
    expect(outcomes).toEqual([
      'issuer: 4403 Grant refused',
      'host: 4403 Grant refused',
      'owner: 4403 Grant refused',
      'epoch: 4403 Grant refused',
      'lifetime: 4401 Grant refused',
      'early edge: ready',
      'early: 4401 Grant refused',
      'late edge: ready',
      'late: 4401 Grant refused',
      'revoked: 4403 Grant refused 4403 Grant refused',
    ])
  })

  it('proves the Host in ready with the injected signer and intersected capabilities', async () => {
    const h = harness({ capabilities: ['sessions.read'] })
    const a = h.connect(),
      b = h.connect()
    a.auth(grant({ caps: ['sessions.control', 'sessions.read'] }))
    await flush()
    b.auth(grant({ client: SECOND }), 'd'.repeat(64))
    await flush()
    expect(a.frames).toEqual([
      {
        type: 'ready',
        protocolVersion: HOST_PROTOCOL_VERSION,
        hello: {
          hostId: HOST_ID,
          hostVersion: '0.0.0',
          protocolVersion: 1,
          runtimeEpoch: 'epoch-1',
          capabilities: ['sessions.read'],
        },
        proof: encodeBase64url(new Uint8Array(64).fill(9)),
        connectionId: 'epoch-2',
        grantExpiresAt: new Date((SECONDS + 300) * 1000).toISOString(),
        client: FIRST,
        capabilities: ['sessions.read'],
      },
    ])
    expect(b.frames[0]).toMatchObject({ connectionId: 'epoch-3', client: SECOND })
    expect(h.signed).toEqual([
      new TextDecoder().decode(grantUtf8(helloProofMessage(HOST_ID, 'epoch-1', CHALLENGE))),
      new TextDecoder().decode(grantUtf8(helloProofMessage(HOST_ID, 'epoch-1', 'd'.repeat(64)))),
    ])
  })

  it('requires a first challenge, caps sockets per client and clears the auth deadline', async () => {
    const h = harness({ limits: { connectionsPerClient: 1, authTimeoutMs: 20 } })
    const bare = h.connect()
    bare.auth(grant(), null)
    await flush()
    const a = h.connect(),
      extra = h.connect(),
      other = h.connect()
    a.auth(grant())
    await flush()
    extra.auth(grant())
    other.auth(grant({ client: SECOND }))
    await flush(20)
    expect([bare.closes, a.closes, extra.closes, other.closes]).toEqual([
      ['4401 Challenge required'],
      [],
      ['4429 Too many connections'],
      [],
    ])
    expect([a.types(), other.types()]).toEqual([['ready'], ['ready']])
  })
})

describe('renewal through createFakeHost', () => {
  it('renews in place, re-arms expiry at exp plus skew and refuses changed identity', async () => {
    const h = harness()
    const a = h.connect()
    a.auth(grant())
    await flush(50_000)
    a.send({ type: 'ping', at: 1 })
    await flush(50_000)
    a.auth(grant(), null)
    await flush()
    for (let i = 0; i < 7; i++) {
      await flush(50_000)
      a.send({ type: 'ping', at: i })
    }
    await flush(9_999)
    expect(a.closes).toEqual([])
    await flush(1)
    expect(a.closes).toEqual(['4401 Grant expired'])
    expect(a.frames.find((f) => f.type === 'auth-renewed')).toEqual({
      type: 'auth-renewed',
      grantExpiresAt: new Date((SECONDS + 400) * 1000).toISOString(),
    })
    const refusals: string[] = []
    for (const [token, challenge] of [
      [grant({ client: SECOND }), null],
      [grant(), CHALLENGE],
      [grant({ epoch: 2 }), null],
      [grant({}, 8), null],
    ] as const) {
      const v = h.connect()
      v.auth(grant())
      await flush()
      v.auth(token, challenge)
      await flush()
      refusals.push(v.closes.join(','))
    }
    expect(refusals).toEqual([
      '4403 Identity changed',
      '4403 Identity changed',
      '4403 Grant refused',
      '4401 Invalid grant',
    ])
    expect(h.signed).toHaveLength(5)
  })

  it('ends read subscriptions silently when renewal drops read, and follows the latest grant', async () => {
    const h = harness({ commandDelayMs: 1 })
    const a = h.connect()
    a.auth(grant())
    await flush()
    a.send({
      type: 'command',
      requestId: '00000000-0000-4000-9000-000000000001',
      op: { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null },
    })
    a.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
    a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    a.auth(grant({ caps: ['sessions.control'] }), null)
    await flush()
    a.frames.length = 0
    h.host.emitTurn(LANE)
    a.send({ type: 'subscribe', id: 'again', topic: 'lane', laneId: LANE })
    const abort = (n: number): ClientFrame => ({
      type: 'command',
      requestId: `00000000-0000-4000-9000-00000000000${n}`,
      laneId: LANE,
      fence: 1,
      op: { type: 'abort' },
    })
    a.send(abort(2))
    await flush(1)
    a.auth(grant({ caps: ['sessions.read'] }), null)
    a.send({ type: 'subscribe', id: 'again', topic: 'lane', laneId: LANE })
    a.send(abort(3))
    await flush(1)
    expect(
      a.frames.map((f) => (f.type === 'receipt' ? `receipt:${f.receipt.status}` : f.type)),
    ).toEqual(['subscribe-failed', 'receipt:done', 'auth-renewed', 'snapshot', 'receipt:rejected'])
    expect(a.frames[0]).toEqual({ type: 'subscribe-failed', id: 'again', code: 'forbidden' })
    expect(a.frames.at(-1)).toMatchObject({ receipt: { code: 'forbidden' } })
  })

  it('reconnects a returning controller on its first auth only, keeping the fence', async () => {
    const h = harness()
    const a = h.connect()
    a.auth(grant())
    await flush()
    a.send({
      type: 'command',
      requestId: '00000000-0000-4000-9000-000000000001',
      op: { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null },
    })
    const watcher = h.connect()
    watcher.auth(grant({ client: SECOND }))
    await flush()
    watcher.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    a.pair.sever()
    await flush()
    const other = h.connect()
    other.auth(grant({ client: SECOND }))
    await flush()
    const back = h.connect()
    back.auth(grant())
    await flush()
    back.auth(grant(), null)
    await flush()
    const control = watcher.frames.flatMap((f) =>
      f.type === 'event' && f.event.kind !== 'pi'
        ? [
            f.event.kind === 'control'
              ? `control:f${f.event.control.fence}:${f.event.control.controller?.connected}`
              : `${f.event.kind}:${f.cursor.seq}`,
          ]
        : [],
    )
    expect(control).toEqual(['control:f1:false', 'summary:2', 'control:f1:true', 'summary:4'])
    expect(back.types()).toEqual(['ready', 'auth-renewed'])
  })
})

describe('auth module', () => {
  function state(extra: Partial<FakeHostOptions> = {}) {
    let epochs = 0
    const verified: string[] = [],
      signed: string[] = []
    const s = createFakeHostState({
      expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
      verify: (bytes, signature, kid) => {
        verified.push(`${kid}:${signature[0]}`)
        return signature.every((b) => b === 7)
      },
      sign: (bytes) => {
        signed.push(new TextDecoder().decode(bytes))
        return new Uint8Array(64).fill(9)
      },
      id: () => LANE,
      epoch: () => `epoch-${++epochs}`,
      ...extra,
    })
    return { s, verified, signed }
  }
  function connection(s: FakeHostState, client: GrantClient | null = null) {
    const frames: HostFrame[] = [],
      closes: string[] = []
    let open = true
    const c: Connection = {
      socket: {
        send: (text) => void frames.push(JSON.parse(text)),
        close: (code, reason) => {
          open = false
          closes.push(`${code} ${reason}`)
        },
        onMessage: () => undefined,
        onClose: () => undefined,
        isOpen: () => open,
        bufferedBytes: () => 0,
      },
      grant: client ? payload({ client }) : null,
      subscriptions: new Map(),
      wanted: new Set(),
      delivered: new Set(),
      pending: 0,
      calls: 0,
      stale: new Set(),
      authTimer: setTimeout(() => closes.push('auth timeout'), 1000),
    }
    s.connections.add(c)
    return { c, frames, closes }
  }
  const authFrame = (
    token: string,
    challenge?: string,
  ): Extract<ClientFrame, { type: 'auth' }> => ({
    type: 'auth',
    grant: token,
    ...(challenge === undefined ? {} : { challenge }),
  })

  it('counts a capability only when both the grant and the Host announce it', () => {
    const { s } = state({ capabilities: ['sessions.read'] })
    const anonymous = connection(s),
      viewer = connection(s, FIRST)
    expect(authorized(s, anonymous.c, 'sessions.read')).toBe(false)
    expect(authorized(s, viewer.c, 'sessions.read')).toBe(true)
    expect(authorized(s, viewer.c, 'sessions.control')).toBe(false)
    viewer.c.grant = payload({ caps: ['sessions.control'] })
    expect(authorized(s, viewer.c, 'sessions.read')).toBe(false)
  })

  it('maps signature and claim failures to their close codes and returns a valid grant', () => {
    const { s, verified } = state()
    const results = [
      grant(),
      grant({}, 8),
      'garbled',
      grant({ exp: SECONDS + 301 }),
      grant({ epoch: 3 }),
    ].map((token) => {
      const v = connection(s)
      return [verifiedGrant(s, v.c, token)?.client.id ?? null, v.closes.join(',')]
    })
    expect(results).toEqual([
      [FIRST.id, ''],
      [null, '4401 Invalid grant'],
      [null, '4401 Invalid grant'],
      [null, '4401 Grant refused'],
      [null, '4403 Grant refused'],
    ])
    expect(verified).toEqual(['test-key:7', 'test-key:8', 'test-key:7', 'test-key:7'])
    s.revokedClients.add(FIRST.id)
    const revoked = connection(s)
    expect(verifiedGrant(s, revoked.c, grant())).toBeNull()
    expect(revoked.closes).toEqual(['4403 Grant refused'])
  })

  it('admits a renewal only with the same owner and client and no challenge', () => {
    const { s } = state()
    const outcomes = [
      [payload(), undefined],
      [payload({ sub: SESSION }), undefined],
      [payload({ client: SECOND }), undefined],
      [payload(), CHALLENGE],
    ] as const
    expect(
      outcomes.map(([next, challenge]) => {
        const v = connection(s, FIRST)
        return `${admitIdentity(s, v.c, authFrame('t', challenge), next)} ${v.closes.join(',')}`
      }),
    ).toEqual([
      'true ',
      'false 4403 Identity changed',
      'false 4403 Identity changed',
      'false 4403 Identity changed',
    ])
  })

  it('needs a non-empty first challenge and a free per-client slot among authenticated sockets', () => {
    const { s } = state({ limits: { connectionsPerClient: 1 } })
    const outcome = (challenge: string | undefined, client: GrantClient) => {
      const v = connection(s)
      return `${admitIdentity(s, v.c, authFrame('t', challenge), payload({ client }))} ${v.closes.join(',')}`
    }
    expect([outcome(undefined, FIRST), outcome('', FIRST), outcome(CHALLENGE, FIRST)]).toEqual([
      'false 4401 Challenge required',
      'false 4401 Challenge required',
      'true ',
    ])
    connection(s, FIRST)
    expect([outcome(CHALLENGE, FIRST), outcome(CHALLENGE, SECOND)]).toEqual([
      'false 4429 Too many connections',
      'true ',
    ])
  })

  it('closes at exp plus the skew, immediately once past it, and replaces an earlier timer', async () => {
    const { s } = state()
    const v = connection(s)
    clearTimeout(v.c.authTimer)
    scheduleExpiry(v.c, payload({ exp: SECONDS + 1 }))
    scheduleExpiry(v.c, payload({ exp: SECONDS + 2 }))
    await flush(61_999)
    expect(v.closes).toEqual([])
    await flush(1)
    expect(v.closes).toEqual(['4401 Grant expired'])
    const late = connection(s)
    scheduleExpiry(late.c, payload({ exp: SECONDS - 100 }))
    await flush(0)
    expect(late.closes).toEqual(['4401 Grant expired'])
  })

  it('sends ready with the proof over the current epoch and consumes one epoch per socket', () => {
    const { s, signed } = state()
    const v = connection(s)
    ready(s, v.c, payload(), CHALLENGE)
    s.epoch = 'restarted'
    ready(s, v.c, payload(), CHALLENGE)
    expect(v.frames.map((f) => (f.type === 'ready' ? f.connectionId : f.type))).toEqual([
      'epoch-2',
      'epoch-3',
    ])
    expect(signed).toEqual([
      helloProofMessage(HOST_ID, 'epoch-1', CHALLENGE),
      helloProofMessage(HOST_ID, 'restarted', CHALLENGE),
    ])
  })

  it('reconnects only that client’s disconnected controllers, publishing control then summary', () => {
    const { s } = state()
    const lane = (laneId: string, clientId: string, connected: boolean, fence: number) => {
      const l: Lane = {
        summary: {
          laneId,
          repositoryId: REPOSITORY.id,
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
          control: { fence, controller: { clientId, label: 'x', connected } },
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
      s.lanes.set(laneId, l)
      return l
    }
    const away = lane('away', FIRST.id, false, 7),
      present = lane('present', FIRST.id, true, 2),
      other = lane('other', SECOND.id, false, 3)
    reconnectControllers(s, payload())
    expect(away.summary.control).toEqual({
      fence: 7,
      controller: { clientId: FIRST.id, label: 'x', connected: true },
    })
    expect(away.events.map((e) => e.event.kind)).toEqual(['control', 'summary'])
    expect([
      present.events.length,
      other.events.length,
      other.summary.control.controller?.connected,
    ]).toEqual([0, 0, false])
  })

  it('renews without a new ready, clearing read subscriptions when read authority is gone', () => {
    const { s, signed } = state()
    const v = connection(s, FIRST)
    v.c.subscriptions.set('all', { type: 'subscribe', id: 'all', topic: 'lanes' })
    v.c.stale.add('all')
    authenticate(s, v.c, authFrame(grant({ caps: ['sessions.read'] })))
    expect([v.c.subscriptions.size, v.c.stale.size]).toEqual([1, 1])
    authenticate(s, v.c, authFrame(grant({ caps: ['sessions.control'] })))
    expect([v.c.subscriptions.size, v.c.stale.size, signed.length]).toEqual([0, 0, 0])
    expect(v.frames.map((f) => f.type)).toEqual(['auth-renewed', 'auth-renewed'])
    expect(v.c.grant?.caps).toEqual(['sessions.control'])
  })

  it('clears the auth deadline on a first auth and leaves a refused socket ungranted', async () => {
    const { s } = state()
    const v = connection(s),
      refused = connection(s)
    authenticate(s, v.c, authFrame(grant(), CHALLENGE))
    authenticate(s, refused.c, authFrame(grant(), undefined))
    await flush(1000)
    expect([v.closes, v.frames.map((f) => f.type), v.c.grant?.client]).toEqual([
      [],
      ['ready'],
      FIRST,
    ])
    expect([refused.closes, refused.c.grant]).toEqual([
      ['4401 Challenge required', 'auth timeout'],
      null,
    ])
  })
})
