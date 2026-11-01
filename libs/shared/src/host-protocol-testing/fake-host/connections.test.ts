import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRANT_LIMITS, type GrantClient, type GrantPayload } from '../../host-grant'
import type { ClientFrame, FrameSocket, HostFrame } from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import { createFakeHost, type FakeHostOptions } from '../fake-host'
import { createLoopbackPair } from '../loopback'
import { attach, disconnect, dispatch, receive, receiptStatus } from './connections'
import { createFakeHostState, type FakeHostState, type Limits } from './state'

const ISSUER = 'https://control.test'
const HOST_ID = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000a2'
const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }
const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/test/repository' }
const LANE = '00000000-0000-4000-8000-000000000001'
const READ_CONTROL: HostCapability[] = ['sessions.read', 'sessions.control']
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const hosts: ReturnType<typeof createFakeHost>[] = []

/** Public-entry harness: grants are looked up by token, so no signing is involved. */
function harness(extra: Partial<FakeHostOptions> = {}) {
  let ids = 0,
    epochs = 0
  const grants = new Map<string, GrantPayload>()
  const host = createFakeHost({
    expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
    verify: () => false,
    verifyGrant: (token) => grants.get(token) ?? null,
    sign: () => new Uint8Array(64),
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    epoch: () => `${++epochs}`.padStart(16, '0'),
    repositories: [REPOSITORY],
    ...extra,
  })
  hosts.push(host)
  function token(client = FIRST, caps = READ_CONTROL) {
    const iat = Math.floor(Date.now() / 1000)
    const name = `grant-${grants.size}`
    grants.set(name, {
      v: 1,
      iss: ISSUER,
      kid: 'key',
      sub: OWNER,
      sid: '00000000-0000-4000-8000-0000000000a3',
      hostId: HOST_ID,
      epoch: 1,
      client,
      caps,
      iat,
      exp: iat + 300,
      jti: '0123456789abcdef',
    })
    return name
  }
  function connect() {
    const pair = createLoopbackPair()
    const frames: HostFrame[] = [],
      closes: string[] = []
    pair.client.onMessage((text) => frames.push(JSON.parse(text)))
    pair.client.onClose((code, reason) => closes.push(`${code} ${reason}`))
    host.attach(pair.server)
    return {
      pair,
      frames,
      closes,
      raw: (text: string) => pair.client.send(text),
      send: (frame: ClientFrame) => pair.client.send(JSON.stringify(frame)),
      brief: () => frames.map(brief),
    }
  }
  async function viewer(client = FIRST, caps = READ_CONTROL) {
    const v = connect()
    v.send({ type: 'auth', grant: token(client, caps), challenge: 'c'.repeat(64) })
    await flush()
    v.frames.length = 0
    return v
  }
  async function createLane(v: Awaited<ReturnType<typeof viewer>>) {
    v.send({
      type: 'command',
      requestId: '00000000-0000-4000-9000-000000000001',
      op: { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null },
    })
    await flush()
    v.frames.length = 0
  }
  return { host, token, connect, viewer, createLane }
}
function brief(f: HostFrame): string {
  switch (f.type) {
    case 'receipt':
      return `receipt ${f.receipt.status}${f.receipt.status === 'rejected' ? ' ' + f.receipt.code : ''}`
    case 'result':
      return `result ${f.id} ${f.ok ? 'ok' : f.error.code}`
    case 'subscribe-failed':
      return `subscribe-failed ${f.id} ${f.code}`
    case 'snapshot':
      return `snapshot ${f.id} ${f.reset ? 'reset' : 'fresh'} ${f.snapshot.cursor.seq} p${f.snapshot.pending.length}`
    case 'event':
      return `event ${f.id} ${f.cursor.seq}`
    case 'lanes':
      return `lanes ${f.id} ${f.cursor.epoch.slice(-1)}:${f.cursor.seq}`
    case 'attention':
      return `attention ${f.id} ${f.cursor.seq}`
    default:
      return f.type
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  await flush()
  vi.useRealTimers()
})

describe('connections through createFakeHost', () => {
  it('answers a malformed frame by its reply kind and ignores frames it does not model', async () => {
    const h = harness()
    const v = await h.viewer()
    v.raw(JSON.stringify({ type: 'command', requestId: LANE, op: { type: 'new_session' } }))
    v.raw(JSON.stringify({ type: 'command', requestId: LANE, laneId: 'x', op: { type: 'abort' } }))
    v.raw(JSON.stringify({ type: 'call', id: 'bad', method: 5 }))
    v.send({ type: 'terminal.input', terminalId: LANE, seq: 1, data: 'ls' })
    v.send({ type: 'subscribe', topic: 'terminal', id: 'term', terminalId: LANE })
    await flush()
    expect([v.brief(), v.closes]).toEqual([
      [
        'receipt rejected unsupported',
        'receipt rejected bad-request',
        'result bad bad-request',
        'subscribe-failed term bad-request',
      ],
      [],
    ])
    v.raw(JSON.stringify({ type: 'nope' }))
    await flush()
    expect(v.closes).toEqual(['4400 Bad frame'])
  })

  it('caps all sockets, authenticated or not, at connectionsPerClient times lanesPerHost', async () => {
    const h = harness({ limits: { connectionsPerClient: 1, lanesPerHost: 2, authTimeoutMs: 20 } })
    const a = h.connect(),
      b = h.connect(),
      c = h.connect()
    await flush()
    expect([a.closes, b.closes, c.closes]).toEqual([[], [], ['4429 Too many connections']])
    await flush(20)
    const d = h.connect()
    await flush()
    expect([a.closes, d.closes]).toEqual([['4401 Auth timeout'], []])
  })

  it('marks a controller away only when its last socket closes, and clears every socket timer', async () => {
    const h = harness()
    const a = await h.viewer(),
      again = await h.viewer(),
      watcher = await h.viewer(SECOND)
    await h.createLane(a)
    watcher.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    a.pair.sever()
    await flush()
    const afterFirst = watcher.brief()
    again.pair.sever()
    await flush()
    expect([afterFirst, watcher.brief()]).toEqual([
      ['snapshot lane fresh 0 p0'],
      ['snapshot lane fresh 0 p0', 'event lane 1', 'event lane 2'],
    ])
    watcher.pair.sever()
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('subscriptions through createFakeHost', () => {
  it('refuses by topic, then authority, then duplicate id, then count, then unknown lane', async () => {
    const h = harness({ limits: { subscriptionsPerConnection: 1 } })
    const reader = await h.viewer(SECOND, [])
    reader.send({ type: 'subscribe', topic: 'terminal', id: 'term', terminalId: LANE })
    reader.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
    const v = await h.viewer()
    v.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
    v.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
    v.send({ type: 'subscribe', id: 'other', topic: 'lane', laneId: LANE })
    v.send({ type: 'unsubscribe', id: 'all' })
    v.send({ type: 'subscribe', id: 'missing', topic: 'lane', laneId: LANE })
    await flush()
    expect([reader.brief(), v.brief()]).toEqual([
      ['subscribe-failed term bad-request', 'subscribe-failed all forbidden'],
      [
        'lanes all 1:0',
        'subscribe-failed all bad-request',
        'subscribe-failed other too-many',
        'subscribe-failed missing unknown-lane',
      ],
    ])
  })

  it('replays inside the window, sends nothing at the head and resets outside it', async () => {
    const h = harness({ limits: { replayEvents: 3 } })
    const v = await h.viewer()
    await h.createLane(v)
    for (let i = 0; i < 2; i++) h.host.emitTurn(LANE)
    await flush()
    const subscribe = (id: string, after?: { epoch: string; seq: number }) =>
      v.send({ type: 'subscribe', id, topic: 'lane', laneId: LANE, ...(after ? { after } : {}) })
    const epoch = '0000000000000001'
    subscribe('head', { epoch, seq: 14 })
    subscribe('edge', { epoch, seq: 11 })
    subscribe('gap', { epoch, seq: 10 })
    subscribe('ahead', { epoch, seq: 15 })
    subscribe('epoch', { epoch: '0000000000000009', seq: 13 })
    subscribe('fresh')
    await flush()
    expect(v.brief()).toEqual([
      'event edge 12',
      'event edge 13',
      'event edge 14',
      'snapshot gap reset 14 p0',
      'snapshot ahead reset 14 p0',
      'snapshot epoch reset 14 p0',
      'snapshot fresh fresh 14 p0',
    ])
  })

  it('replays attention after the cursor within the epoch only', async () => {
    const h = harness()
    const v = await h.viewer()
    await h.createLane(v)
    h.host.emitTurn(LANE)
    h.host.emitTurn(LANE)
    await flush()
    v.send({
      type: 'subscribe',
      id: 'all',
      topic: 'lanes',
      after: { epoch: '0000000000000001', seq: 3 },
    })
    v.send({
      type: 'subscribe',
      id: 'other',
      topic: 'lanes',
      after: { epoch: '0000000000000002', seq: 0 },
    })
    await flush()
    expect(v.brief()).toEqual([
      'lanes all 1:7',
      'attention all 4',
      'attention all 7',
      'lanes other 1:7',
    ])
  })
})

describe('calls through createFakeHost', () => {
  it('answers lane reads on the next tick, with messages read when the answer is sent', async () => {
    const h = harness()
    const v = await h.viewer()
    await h.createLane(v)
    const call = (id: string, method: string, params: unknown = { laneId: LANE }) =>
      v.send({ type: 'call', id, method, params } as ClientFrame)
    for (const method of [
      'lane.state',
      'lane.messages',
      'lane.stats',
      'lane.models',
      'lane.commands',
    ])
      call(method.replace('.', '_'), method)
    call('repositories', 'host.repositories', {})
    call('unsupported', 'other.method')
    call('no-lane', 'lane.state', {})
    call('unknown', 'lane.state', { laneId: '00000000-0000-4000-8000-0000000000ff' })
    await Promise.resolve()
    await Promise.resolve()
    h.host.emitTurn(LANE)
    await flush()
    const results = v.frames.flatMap((f) => (f.type === 'result' ? [f] : []))
    expect(results.map((f) => `${f.id} ${f.ok ? 'ok' : f.error.code}`)).toEqual([
      'repositories ok',
      'unsupported unsupported',
      'no-lane bad-request',
      'unknown unknown-lane',
      'lane_state ok',
      'lane_messages ok',
      'lane_stats ok',
      'lane_models ok',
      'lane_commands ok',
    ])
    const data = Object.fromEntries(results.flatMap((f) => (f.ok ? [[f.id, f.data]] : [])))
    expect(data['lane_state']).toMatchObject({ messageCount: 0, isStreaming: false })
    expect(data['lane_messages']).toMatchObject({ messages: [{ role: 'assistant' }] })
    expect(data['lane_stats']).toMatchObject({ assistantMessages: 0, totalMessages: 0 })
    expect([data['lane_models'], data['lane_commands']]).toEqual([{ models: [] }, { commands: [] }])
  })

  it('bounds lane reads per socket and drops answers after read authority or the socket is gone', async () => {
    const h = harness({ limits: { pendingCommandsPerConnection: 2 } })
    const v = await h.viewer(),
      closing = await h.viewer()
    await h.createLane(v)
    const read = (target: typeof v, id: string) =>
      target.send({ type: 'call', id, method: 'lane.state', params: { laneId: LANE } })
    read(v, 'one')
    v.send({ type: 'call', id: 'repositories', method: 'host.repositories', params: {} })
    read(v, 'two')
    v.send({ type: 'auth', grant: h.token(FIRST, ['sessions.control']) })
    read(closing, 'lost')
    closing.send({ type: 'call', id: 'lost-too', method: 'lane.state', params: { laneId: LANE } })
    read(closing, 'over')
    await flush()
    expect([v.brief(), v.closes]).toEqual([['result repositories ok', 'auth-renewed'], []])
    expect([closing.brief(), closing.closes]).toEqual([[], ['4429 Too many calls']])
  })
})

describe('driver through createFakeHost', () => {
  it('bounds dialogs and revocations, and fails a lane with an exit then attention', async () => {
    const h = harness({ limits: { pendingEvents: 1 } })
    const v = await h.viewer()
    await h.createLane(v)
    v.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    h.host.openDialog(LANE)
    expect(() => h.host.openDialog(LANE, 'second')).toThrow('Too many dialogs')
    h.host.failLane(LANE)
    expect(() => h.host.failLane('00000000-0000-4000-8000-0000000000ff')).toThrow('Unknown lane')
    for (let i = 0; i < GRANT_LIMITS.revocations; i++) {
      h.host.revokeSession(`session-${i}`)
      h.host.revokeClient(`client-${i}`)
    }
    expect(() => h.host.revokeSession('one more')).toThrow('Revocations full')
    expect(() => h.host.revokeClient('one more')).toThrow('Revocations full')
    await flush()
    const kinds = v.frames.flatMap((f) =>
      f.type === 'event'
        ? [f.event.kind === 'pi' ? `pi:${f.event.push.kind}` : `${f.event.kind}`]
        : [f.type],
    )
    expect(kinds).toEqual(['snapshot', 'pi:extension-ui', 'summary', 'pi:exit', 'summary'])
    expect(v.closes).toEqual([])
  })

  it('restarts with a new epoch, an empty replay and no pending events', async () => {
    const h = harness({ limits: { pendingEvents: 2 } })
    const v = await h.viewer()
    await h.createLane(v)
    expect(() => h.host.emitTurn(LANE)).toThrow('Scripted pending limit exceeded')
    const before = await h.viewer()
    before.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    h.host.restart()
    await flush()
    // The returning controller's away and reconnect events are seq 1-4 of the new epoch.
    const after = await h.viewer()
    after.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    await flush()
    expect([before.brief(), after.brief(), v.closes]).toEqual([
      ['snapshot lane fresh 3 p2'],
      ['snapshot lane fresh 4 p0'],
      ['1001 Host restarting'],
    ])
    expect(after.frames[0]).toMatchObject({
      snapshot: { cursor: { epoch: '0000000000000004', seq: 4 }, messages: [] },
    })
  })

  it('stops answering calls in flight and leaves no timer after stop', async () => {
    const h = harness()
    const v = await h.viewer()
    await h.createLane(v)
    v.send({ type: 'call', id: 'state', method: 'lane.state', params: { laneId: LANE } })
    await Promise.resolve()
    await Promise.resolve()
    h.host.stop()
    await flush(1000)
    expect([v.brief(), v.closes, vi.getTimerCount()]).toEqual([[], ['1001 Host stopping'], 0])
  })
})

describe('connections module', () => {
  function state(limits: Partial<Limits> = {}) {
    return createFakeHostState({
      expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
      verify: () => false,
      sign: () => new Uint8Array(64),
      id: () => LANE,
      epoch: () => 'epoch',
      repositories: [REPOSITORY],
      limits,
    })
  }
  /** A socket whose message and close callbacks the test drives by hand. */
  function socket() {
    const wire = {
      open: true,
      frames: [] as HostFrame[],
      closes: [] as string[],
      message: (_text: string) => undefined as void,
      close: () => undefined as void,
    }
    const s: FrameSocket = {
      send: (text) => void wire.frames.push(JSON.parse(text)),
      close: (code, reason) => {
        wire.open = false
        wire.closes.push(`${code} ${reason}`)
      },
      onMessage: (cb) => void (wire.message = cb),
      onClose: (cb) => void (wire.close = () => cb(1000, 'closed')),
      isOpen: () => wire.open,
      bufferedBytes: () => 0,
    }
    return { s, wire }
  }
  function attached(st: FakeHostState, client: GrantClient | null = FIRST) {
    const { s, wire } = socket()
    attach(st, s)
    const c = [...st.connections].at(-1)
    if (!c) throw new Error('Not attached')
    if (client) {
      const iat = Math.floor(Date.now() / 1000)
      c.grant = {
        v: 1,
        iss: ISSUER,
        kid: 'key',
        sub: OWNER,
        sid: 'session',
        hostId: HOST_ID,
        epoch: 1,
        client,
        caps: READ_CONTROL,
        iat,
        exp: iat + 300,
        jti: '0123456789abcdef',
      }
      clearTimeout(c.authTimer)
    }
    return { c, wire }
  }

  it('refuses a socket while stopping or at the flood cap, and arms the auth deadline', async () => {
    const st = state({ connectionsPerClient: 1, lanesPerHost: 1, authTimeoutMs: 20 })
    const first = attached(st, null)
    const crowded = socket()
    attach(st, crowded.s)
    st.stopped = true
    const stopping = socket()
    attach(st, stopping.s)
    expect([st.connections.size, crowded.wire.closes, stopping.wire.closes]).toEqual([
      1,
      ['4429 Too many connections'],
      ['1001 Host stopping'],
    ])
    await flush(19)
    expect(first.wire.closes).toEqual([])
    await flush(1)
    expect(first.wire.closes).toEqual(['4401 Auth timeout'])
  })

  it('re-arms idle on every message and checks size before parsing', async () => {
    const st = state({ idleCloseMs: 30, inboundFrameBytes: 64 })
    const v = attached(st)
    receive(st, v.c, JSON.stringify({ type: 'ping', at: 1 }))
    await flush(20)
    v.wire.message(JSON.stringify({ type: 'ping', at: 2 }))
    await flush(29)
    expect(v.wire.closes).toEqual([])
    await flush(1)
    expect(v.wire.closes).toEqual(['4401 Idle'])
    const big = attached(st)
    receive(st, big.c, `{"type":"ping","at":1,"pad":"${'x'.repeat(64)}"}`)
    expect([big.wire.frames, big.wire.closes]).toEqual([[], ['4400 Frame too large']])
  })

  it('answers refused frames by reply kind once granted, and requires auth before that', () => {
    const st = state()
    const anonymous = attached(st, null)
    receive(
      st,
      anonymous.c,
      JSON.stringify({ type: 'command', requestId: LANE, op: { type: 'new_session' } }),
    )
    const v = attached(st)
    receive(
      st,
      v.c,
      JSON.stringify({ type: 'command', requestId: LANE, op: { type: 'new_session' } }),
    )
    receive(st, v.c, JSON.stringify({ type: 'call', id: 'bad', method: 5 }))
    receive(st, v.c, '{')
    expect(anonymous.wire.closes).toEqual(['4401 Auth required'])
    expect([v.wire.frames.map(brief), v.wire.closes]).toEqual([
      ['receipt rejected unsupported', 'result bad bad-request'],
      ['4400 Bad frame'],
    ])
  })

  it('dispatches by frame type after auth and ignores frames it does not model', () => {
    const st = state()
    const anonymous = attached(st, null)
    dispatch(st, anonymous.c, { type: 'ping', at: 1 })
    const v = attached(st)
    dispatch(st, v.c, { type: 'ping', at: 2 })
    dispatch(st, v.c, { type: 'terminal.input', terminalId: LANE, seq: 1, data: 'ls' })
    dispatch(st, v.c, { type: 'subscribe', id: 'all', topic: 'lanes' })
    dispatch(st, v.c, { type: 'unsubscribe', id: 'all' })
    dispatch(st, v.c, { type: 'call', id: 'repositories', method: 'host.repositories' })
    expect([anonymous.wire.closes, v.wire.frames.map(brief), v.c.subscriptions.size]).toEqual([
      ['4401 Auth required'],
      ['pong', 'lanes all h:0', 'result repositories ok'],
      0,
    ])
  })

  it('looks up only the asking client’s receipts, registering interest while pending', () => {
    const st = state()
    const v = attached(st),
      other = attached(st, SECOND)
    st.receipts.set('p', {
      clientId: FIRST.id,
      hash: '',
      receipt: { requestId: 'p', status: 'pending' },
    })
    receiptStatus(st, v.c, 'p')
    receiptStatus(st, v.c, 'missing')
    receiptStatus(st, other.c, 'p')
    expect([v.wire.frames.map(brief), other.wire.frames.map(brief)]).toEqual([
      ['receipt pending', 'receipt unknown'],
      ['receipt unknown'],
    ])
    expect([[...v.c.wanted], other.c.wanted.size]).toEqual([['p'], 0])
  })

  it('clears socket timers and marks a controller away after its last socket only', async () => {
    const st = state({ idleCloseMs: 30 })
    const a = attached(st),
      b = attached(st)
    for (const v of [a, b]) receive(st, v.c, JSON.stringify({ type: 'ping', at: 1 }))
    receive(
      st,
      a.c,
      JSON.stringify({
        type: 'command',
        requestId: LANE,
        op: { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null },
      }),
    )
    const lane = st.lanes.get(LANE)
    a.wire.close()
    expect([st.connections.size, lane?.summary.control.controller?.connected]).toEqual([1, true])
    b.wire.close()
    expect([st.connections.size, lane?.summary.control]).toEqual([
      0,
      { fence: 1, controller: { clientId: FIRST.id, label: 'First', connected: false } },
    ])
    expect(lane?.events.map((e) => e.event.kind)).toEqual(['control', 'summary'])
    const anonymous = attached(st, null)
    disconnect(st, anonymous.c)
    expect([lane?.events.length, vi.getTimerCount()]).toEqual([2, 0])
  })
})
