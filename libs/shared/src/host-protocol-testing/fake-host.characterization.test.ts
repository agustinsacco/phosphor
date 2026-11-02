// Frozen public traces of createFakeHost (LS-11). Later fake Host splits must keep them green.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeGrant, type GrantClient, type GrantPayload } from '../host-grant'
import {
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type LaneControl,
  type LaneEvent,
  type LaneSummary,
  type Receipt,
} from '../host-protocol'
import type { ExtensionUIRequest } from '../rpc'
import { createFakeHost, type FakeHostOptions } from './fake-host'
import { createLoopbackPair } from './loopback'

const HOST_ID = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000a2'
const SESSION = '00000000-0000-4000-8000-0000000000a3'
const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }
const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/test/repository' }
const CHALLENGE = 'c'.repeat(64)
const ISSUER = 'https://control.test'

const rid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
const laneIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hosts: ReturnType<typeof createFakeHost>[] = []

function grant(overrides: Partial<GrantPayload> = {}, signatureByte = 7): string {
  const iat = Math.floor(Date.now() / 1000)
  const payload: GrantPayload = {
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
  return encodeGrant(payload, () => new Uint8Array(64).fill(signatureByte))
}

function makeHost(extra: Partial<FakeHostOptions> = {}) {
  let ids = 0,
    epochs = 0
  const host = createFakeHost({
    expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
    verify: (_bytes, signature, kid) => kid === 'test-key' && signature.every((b) => b === 7),
    sign: (bytes) => new Uint8Array(createHash('sha512').update(bytes).digest()),
    id: () => laneIdOf(++ids),
    epoch: () => (++epochs).toString(16).padStart(16, '0'),
    repositories: [REPOSITORY],
    ...extra,
  })
  hosts.push(host)
  return host
}
type Host = ReturnType<typeof makeHost>

function connect(host: Host) {
  const pair = createLoopbackPair()
  const texts: string[] = [],
    closes: string[] = []
  pair.client.onMessage((text) => texts.push(text))
  pair.client.onClose((code, reason) => closes.push(`${code} ${reason}`))
  host.attach(pair.server)
  return {
    pair,
    texts,
    closes,
    trace: () => texts.map((text) => brief(JSON.parse(text))),
    send: (frame: ClientFrame) => pair.client.send(JSON.stringify(frame)),
  }
}
type Viewer = ReturnType<typeof connect>

async function viewer(host: Host, client = FIRST) {
  const v = connect(host)
  v.send({ type: 'auth', grant: grant({ client }), challenge: CHALLENGE })
  await flush()
  return v
}
async function createLane(v: Viewer, requestId: string) {
  v.send({
    type: 'command',
    requestId,
    op: { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null, name: 'Lane' },
  })
  await flush()
}
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const digest = (texts: string[]) =>
  createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 16)

const control = (c: LaneControl) =>
  `f${c.fence}:${c.controller ? c.controller.label + (c.controller.connected ? '' : '(away)') : '-'}`
const summary = (s: LaneSummary) =>
  `${s.title ?? '-'} ${s.activity} a${s.attention} r${s.read} ${control(s.control)}`
function event(e: LaneEvent): string {
  if (e.kind === 'summary') return `summary ${summary(e.summary)}`
  if (e.kind === 'control') return `control ${control(e.control)}`
  if (e.kind === 'dialog-resolved') return `dialog-resolved ${e.dialogId}`
  const p = e.push
  return `pi ${p.kind === 'event' ? p.event.type : p.kind === 'extension-ui' ? p.request.method : p.kind}`
}
function receipt(r: Receipt): string {
  const extra =
    r.status === 'rejected'
      ? ` ${r.code}${r.control ? ' ' + control(r.control) : ''}`
      : r.status === 'done'
        ? `${r.fence === undefined ? '' : ' f' + r.fence}${r.laneId ? ' ' + r.laneId.slice(-2) : ''}`
        : ''
  return `receipt ${r.requestId.slice(-2)} ${r.status}${extra}`
}
function brief(f: HostFrame): string {
  switch (f.type) {
    case 'ready':
      return `ready ${f.hello.runtimeEpoch.slice(-2)} ${f.connectionId.slice(-2)} ${f.capabilities.join(',')}`
    case 'lanes':
      return `lanes ${f.id} ${f.cursor.seq} [${f.lanes.map(summary).join('; ')}]`
    case 'lanes-delta':
      return `lanes-delta ${f.id} ${f.cursor.seq} ${f.upsert.map(summary).join('; ')}`
    case 'attention':
      return `attention ${f.id} ${f.cursor.seq} ${f.event.kind} ${f.event.attention}`
    case 'snapshot': {
      const s = f.snapshot
      const sizes = `m${s.messages.length} p${s.pending.length} d${s.dialogs.length} u${s.ui.length}`
      return `snapshot ${f.id} ${f.reset ? 'reset' : 'fresh'} ${s.cursor.seq} ${sizes} ${summary(s.summary)}`
    }
    case 'event':
      return `event ${f.id} ${f.cursor.seq} ${event(f.event)}`
    case 'receipt':
      return receipt(f.receipt)
    case 'result':
      return `result ${f.id} ${f.ok ? 'ok' : f.error.code}`
    case 'subscribe-failed':
      return `subscribe-failed ${f.id} ${f.code}`
    case 'pong':
      return `pong ${f.at}`
    default:
      return f.type
  }
}
const status = (key: string, text?: string): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 'status',
  method: 'setStatus',
  statusKey: key,
  statusText: text,
})
const widget = (key: string, lines: string[]): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 'widget',
  method: 'setWidget',
  widgetKey: key,
  widgetLines: lines,
})
const title = (text: string): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 'title',
  method: 'setTitle',
  title: text,
})
const notice: ExtensionUIRequest = {
  type: 'extension_ui_request',
  id: 'notice',
  method: 'notify',
  message: 'Notice',
}

// Readable traces: one line per Host frame, projected by brief(). Digests pin the exact bytes.
const ONE_VIEWER = [
  'ready 01 02 sessions.read,sessions.control',
  'lanes all 0 []',
  'lanes-delta all 1 Lane idle a0 r0 f1:First',
  'receipt 01 done f1 01',
  'snapshot lane fresh 0 m0 p0 d0 u0 Lane idle a0 r0 f1:First',
  'receipt 02 pending',
  'event lane 1 summary Lane working a0 r0 f1:First',
  'lanes-delta all 2 Lane working a0 r0 f1:First',
  'event lane 2 pi agent_start',
  'event lane 3 pi message_update',
  'event lane 4 pi message_update',
  'event lane 5 pi message_end',
  'event lane 6 pi agent_end',
  'event lane 7 summary Lane idle a1 r0 f1:First',
  'lanes-delta all 3 Lane idle a1 r0 f1:First',
  'attention all 4 finished 1',
  'receipt 02 done f1',
  'event lane 8 summary Renamed idle a1 r0 f1:First',
  'lanes-delta all 5 Renamed idle a1 r0 f1:First',
  'event lane 9 summary Renamed idle a1 r0 f1:First',
  'lanes-delta all 6 Renamed idle a1 r0 f1:First',
  'event lane 10 summary Renamed idle a1 r1 f1:First',
  'lanes-delta all 7 Renamed idle a1 r1 f1:First',
  'receipt 03 done f1',
  'receipt 04 done f1',
  'receipt 05 done f1',
  'receipt 06 done f1',
  'receipt 02 done f1',
  'result state ok',
]
const RESTART_FIRST = [
  'ready 01 02 sessions.read,sessions.control',
  'receipt 01 done f1 01',
  'lanes all 1 [Lane idle a0 r0 f1:First]',
  'snapshot lane fresh 0 m0 p0 d0 u0 Lane idle a0 r0 f1:First',
  'event lane 1 summary Lane working a0 r0 f1:First',
  'lanes-delta all 2 Lane working a0 r0 f1:First',
  'event lane 2 pi agent_start',
  'event lane 3 pi message_update',
  'event lane 4 pi message_update',
  'event lane 5 pi message_end',
  'event lane 6 pi agent_end',
  'event lane 7 summary Lane idle a1 r0 f1:First',
  'lanes-delta all 3 Lane idle a1 r0 f1:First',
  'attention all 4 finished 1',
  'event lane 8 pi setStatus',
  'event lane 9 pi notify',
  'event lane 10 pi confirm',
  'event lane 11 summary Lane needs-input a2 r0 f1:First',
  'lanes-delta all 5 Lane needs-input a2 r0 f1:First',
  'attention all 6 needs-input 2',
  'pong 7',
]
const RESTART_SECOND = [
  'ready 03 04 sessions.read,sessions.control',
  'receipt 02 unknown',
  'lanes all 2 [Lane needs-input a2 r0 f1:First]',
  'snapshot old reset 4 m1 p0 d1 u1 Lane needs-input a2 r0 f1:First',
  'event now 1 control f1:First(away)',
  'event now 2 summary Lane needs-input a2 r0 f1:First(away)',
  'event now 3 control f1:First',
  'event now 4 summary Lane needs-input a2 r0 f1:First',
]
const STOP_TRACE = [
  'ready 01 02 sessions.read,sessions.control',
  'receipt 01 done f1 01',
  'snapshot lane fresh 0 m0 p0 d0 u0 Lane idle a0 r0 f1:First',
]
const PRE_AUTH_CLOSES = [
  'ping: 4401 Auth required frames 0',
  'malformed: 4401 Auth required frames 0',
  'oversize: 4400 Frame too large frames 0',
  'bad signature: 4401 Invalid grant frames 0',
  'wrong owner: 4403 Grant refused frames 0',
  'wrong host: 4403 Grant refused frames 0',
  'no challenge: 4401 Challenge required frames 0',
  'timeout: 4401 Auth timeout frames 0',
  'expired: 4401 Grant refused',
]
const POST_AUTH_CLOSES = [
  'bad frame: 4400 Bad frame',
  'idle: 4401 Idle',
  'identity: 4403 Identity changed',
  'second socket: 4429 Too many connections kept 0',
  'revoked: 4403 Revoked',
  'calls: receipt 01 done f1 01 4429 Too many calls',
]
const RENEWAL = [
  ['4401 Grant expired'],
  ['ready 01 02 sessions.read,sessions.control', 'pong 1'],
  ['4403 Identity changed'],
  ['ready 01 03 sessions.read,sessions.control', 'auth-renewed'],
]
const TWO_FIRST = [
  'ready 01 02 sessions.read,sessions.control',
  'receipt 01 done f1 01',
  'snapshot lane fresh 0 m0 p0 d0 u0 Lane idle a0 r0 f1:First',
  'event lane 1 summary Lane working a0 r0 f1:First',
  'event lane 2 pi agent_start',
  'event lane 3 pi message_update',
  'event lane 4 pi message_update',
  'event lane 5 pi message_end',
  'event lane 6 pi agent_end',
  'event lane 7 summary Lane idle a1 r0 f1:First',
  'event lane 8 control f2:Second',
  'event lane 9 summary Lane idle a1 r0 f2:Second',
  'receipt 04 rejected stale-fence f2:Second',
]
const TWO_SECOND = [
  'ready 01 03 sessions.read,sessions.control',
  'snapshot lane fresh 0 m0 p0 d0 u0 Lane idle a0 r0 f1:First',
  'event lane 1 summary Lane working a0 r0 f1:First',
  'event lane 2 pi agent_start',
  'event lane 3 pi message_update',
  'event lane 4 pi message_update',
  'event lane 5 pi message_end',
  'event lane 6 pi agent_end',
  'event lane 7 summary Lane idle a1 r0 f1:First',
  'receipt 02 rejected not-controller f1:First',
  'event lane 8 control f2:Second',
  'event lane 9 summary Lane idle a1 r0 f2:Second',
  'receipt 03 done f2',
  'receipt 03 rejected conflict',
]
const SLOW_FIRST = [
  'event lane 1 summary Lane working a0 r0 f1:First',
  'event lane 2 pi agent_start',
  'event lane 3 pi message_update',
  'event lane 4 pi message_update',
  'event lane 5 pi message_end',
  'event lane 6 pi agent_end',
  'event lane 7 summary Lane idle a1 r0 f1:First',
  'event lane 8 summary Lane working a1 r0 f1:First',
  'event lane 9 pi agent_start',
  'event lane 10 pi message_update',
  'event lane 11 pi message_update',
  'event lane 12 pi message_end',
  'event lane 13 pi agent_end',
  'event lane 14 summary Lane idle a2 r0 f1:First',
  'event lane 15 summary Lane working a2 r0 f1:First',
  'event lane 16 pi agent_start',
  'snapshot lane reset 140 m20 p0 d0 u0 Lane idle a20 r0 f1:First',
  'event lane 141 summary Lane working a20 r0 f1:First',
  'event lane 142 pi agent_start',
  'event lane 143 pi message_update',
  'event lane 144 pi message_update',
  'event lane 145 pi message_end',
  'event lane 146 pi agent_end',
  'event lane 147 summary Lane idle a21 r0 f1:First',
]
const INDEPENDENT = [
  ['1001 Host stopping'],
  [],
  [
    'ready 01 02 sessions.read,sessions.control',
    'lanes all 0 []',
    'receipt 01 unknown',
    'lanes-delta all 1 Lane idle a0 r0 f1:First',
    'receipt 01 done f1 01',
  ],
]
const LIMITS = [
  'ready 01 02 sessions.read,sessions.control',
  'lanes one 0 []',
  'subscribe-failed two too-many',
  'lanes-delta one 1 Lane idle a0 r0 f1:First',
  'receipt 01 done f1 01',
  'receipt 02 rejected too-many-requests',
]
const UI = [
  {
    epoch: '0000000000000001',
    seq: 11,
  },
  ['snapshot lane fresh 11 m0 p0 d0 u4 Lane idle a0 r0 f1:First'],
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  await flush()
  vi.useRealTimers()
})

it('traces one viewer through auth, lane creation, a prompt turn, lane operations and receipts', async () => {
  const host = makeHost({ commandDelayMs: 5 })
  const a = await viewer(host)
  a.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  const prompt: ClientFrame = {
    type: 'command',
    requestId: rid(2),
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hello' },
  }
  a.send(prompt)
  a.send(prompt)
  await flush(5)
  a.send({
    type: 'command',
    requestId: rid(3),
    laneId,
    fence: 1,
    op: { type: 'set_session_name', name: 'Renamed' },
  })
  a.send({
    type: 'command',
    requestId: rid(4),
    laneId,
    fence: 1,
    op: { type: 'set_model', provider: 'p', modelId: 'm' },
  })
  a.send({
    type: 'command',
    requestId: rid(5),
    laneId,
    fence: 1,
    op: { type: 'set_thinking_level', level: 'high' },
  })
  a.send({
    type: 'command',
    requestId: rid(6),
    laneId,
    fence: 1,
    op: { type: 'lane.markRead', upTo: 9 },
  })
  await flush(5)
  a.send({ type: 'receipt-status', requestId: rid(2) })
  a.send({ type: 'call', id: 'state', method: 'lane.state', params: { laneId } })
  await flush()
  expect(a.trace()).toEqual(ONE_VIEWER)
  expect(digest(a.texts)).toBe('6a522e41a7a28bcf')
  expect(host.executions()).toBe(5)
  expect(a.closes).toEqual([])
})

it('traces driver emits, ping and an interrupted receipt, then restart closes and resets the epoch', async () => {
  const host = makeHost({ commandDelayMs: 50 })
  const a = await viewer(host)
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  a.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  expect(host.emitTurn(laneId)).toEqual({ messages: 1, turns: 1 })
  host.emitUi(laneId, status('build', 'ok'))
  host.emitUi(laneId, notice)
  host.openDialog(laneId)
  a.send({ type: 'ping', at: 7 })
  a.send({
    type: 'command',
    requestId: rid(2),
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hi' },
  })
  await flush()
  const before = a.texts.length
  host.restart()
  await flush()
  expect(a.texts.length).toBe(before)
  expect(a.closes).toEqual(['1001 Host restarting'])
  const b = await viewer(host)
  b.send({ type: 'receipt-status', requestId: rid(2) })
  b.send({
    type: 'subscribe',
    id: 'all',
    topic: 'lanes',
    after: { epoch: '0000000000000001', seq: 1 },
  })
  b.send({
    type: 'subscribe',
    id: 'old',
    topic: 'lane',
    laneId,
    after: { epoch: '0000000000000001', seq: 2 },
  })
  await flush(100)
  b.send({ type: 'unsubscribe', id: 'old' })
  b.send({
    type: 'subscribe',
    id: 'now',
    topic: 'lane',
    laneId,
    after: { epoch: '0000000000000003', seq: 0 },
  })
  await flush()
  expect(a.trace()).toEqual(RESTART_FIRST)
  expect(b.trace()).toEqual(RESTART_SECOND)
  expect(digest([...a.texts, ...b.texts])).toBe('317e8c05bad60389')
  expect(host.executions()).toBe(1)
})

it('closes every socket on stop, refuses later attaches and delivers nothing after stop', async () => {
  const host = makeHost({ commandDelayMs: 50 })
  const a = await viewer(host)
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  a.send({
    type: 'command',
    requestId: rid(2),
    laneId,
    fence: 1,
    op: { type: 'prompt', message: 'Hi' },
  })
  await flush()
  const before = a.trace()
  host.stop()
  await flush()
  expect(a.closes).toEqual(['1001 Host stopping'])
  const late = connect(host)
  await flush()
  expect(late.closes).toEqual(['1001 Host stopping'])
  expect(host.emitTurn(laneId)).toEqual({ messages: 1, turns: 1 })
  host.emitUi(laneId, notice)
  await flush(HOST_LIMITS.commandAnswerMs + 100)
  expect(a.trace()).toEqual(before)
  expect(late.texts).toEqual([])
  expect(before).toEqual(STOP_TRACE)
  expect(vi.getTimerCount()).toBe(0)
  expect(host.executions()).toBe(1)
})

it('closes unauthenticated sockets with the exact code and reason', async () => {
  const host = makeHost({ limits: { authTimeoutMs: 20, inboundFrameBytes: 2048 } })
  const cases: [string, (v: Viewer) => void][] = [
    ['ping', (v) => v.send({ type: 'ping', at: 0 })],
    ['malformed', (v) => v.pair.client.send('{')],
    ['oversize', (v) => v.pair.client.send(' '.repeat(2049))],
    ['bad signature', (v) => v.send({ type: 'auth', grant: grant({}, 8), challenge: CHALLENGE })],
    [
      'wrong owner',
      (v) => v.send({ type: 'auth', grant: grant({ sub: SESSION }), challenge: CHALLENGE }),
    ],
    [
      'wrong host',
      (v) => v.send({ type: 'auth', grant: grant({ hostId: SESSION }), challenge: CHALLENGE }),
    ],
    ['no challenge', (v) => v.send({ type: 'auth', grant: grant() })],
    ['timeout', () => undefined],
  ]
  const closes: string[] = []
  for (const [name, act] of cases) {
    const v = connect(host)
    act(v)
    await flush(20)
    closes.push(`${name}: ${v.closes.join(',')} frames ${v.texts.length}`)
  }
  const expired = connect(host)
  const iat = Math.floor(Date.now() / 1000) - 400
  expired.send({ type: 'auth', grant: grant({ iat, exp: iat + 300 }), challenge: CHALLENGE })
  await flush()
  closes.push(`expired: ${expired.closes.join(',')}`)
  expect(closes).toEqual(PRE_AUTH_CLOSES)
})

it('closes authenticated sockets with the exact code and reason', async () => {
  const host = makeHost({
    limits: { idleCloseMs: 30, connectionsPerClient: 1, pendingCommandsPerConnection: 1 },
  })
  const closes: string[] = []
  const bad = await viewer(host)
  bad.pair.client.send('{')
  await flush()
  closes.push(`bad frame: ${bad.closes.join(',')}`)
  const idle = await viewer(host)
  await flush(30)
  closes.push(`idle: ${idle.closes.join(',')}`)
  const changed = await viewer(host)
  changed.send({ type: 'auth', grant: grant({ client: SECOND }) })
  await flush()
  closes.push(`identity: ${changed.closes.join(',')}`)
  const kept = await viewer(host)
  const extra = await viewer(host)
  closes.push(`second socket: ${extra.closes.join(',')} kept ${kept.closes.length}`)
  host.revokeClient(FIRST.id)
  await flush()
  closes.push(`revoked: ${kept.closes.join(',')}`)
  const caller = await viewer(host, SECOND)
  await createLane(caller, rid(1))
  for (const id of ['one', 'two'])
    caller.send({ type: 'call', id, method: 'lane.state', params: { laneId: laneIdOf(1) } })
  await flush()
  closes.push(`calls: ${caller.trace().slice(1).join(',')} ${caller.closes.join(',')}`)
  expect(closes).toEqual(POST_AUTH_CLOSES)
})

it('renews a grant in place and closes an expired grant only after the skew window', async () => {
  const host = makeHost()
  const iat = Math.floor(Date.now() / 1000)
  const expiring = connect(host)
  expiring.send({ type: 'auth', grant: grant({ iat, exp: iat + 1 }), challenge: CHALLENGE })
  await flush(30_000)
  expiring.send({ type: 'ping', at: 1 })
  await flush(30_999)
  expect(expiring.closes).toEqual([])
  await flush(1)
  const renewing = await viewer(host)
  renewing.send({ type: 'auth', grant: grant({ jti: 'fedcba9876543210' }) })
  await flush()
  renewing.send({ type: 'auth', grant: grant(), challenge: CHALLENGE })
  await flush()
  expect([expiring.closes, expiring.trace(), renewing.closes, renewing.trace()]).toEqual(RENEWAL)
  expect(digest([...expiring.texts, ...renewing.texts])).toBe('bfd724df39d49184')
})

it('gives two viewers identical event order, serializes takeover and fences the old controller', async () => {
  const host = makeHost({ commandDelayMs: 1 })
  const a = await viewer(host)
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  const b = await viewer(host, SECOND)
  for (const v of [a, b]) v.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  host.emitTurn(laneId)
  b.send({ type: 'command', requestId: rid(2), laneId, fence: 1, op: { type: 'abort' } })
  await flush(1)
  b.send({ type: 'command', requestId: rid(3), laneId, fence: 1, op: { type: 'control.take' } })
  await flush(1)
  a.send({ type: 'command', requestId: rid(4), laneId, fence: 1, op: { type: 'abort' } })
  b.send({ type: 'command', requestId: rid(3), laneId, fence: 1, op: { type: 'abort' } })
  await flush(1)
  a.pair.sever()
  await flush()
  const events = (v: Viewer) => v.trace().filter((line) => line.startsWith('event '))
  expect(events(a)).toEqual(events(b).slice(0, events(a).length))
  expect(a.trace()).toEqual(TWO_FIRST)
  expect(b.trace()).toEqual(TWO_SECOND)
  expect(digest([...a.texts, ...b.texts])).toBe('a894e7f879b8054b')
})

it('recovers one slow viewer with a single reset snapshot without slowing the other', async () => {
  const host = makeHost({ limits: { sendQueueBytes: 6000 } })
  const a = await viewer(host)
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  const b = await viewer(host, SECOND)
  for (const v of [a, b]) v.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  a.texts.length = 0
  b.texts.length = 0
  a.pair.pause()
  for (let i = 0; i < 20; i++) {
    host.emitTurn(laneId)
    await flush()
  }
  a.pair.resume()
  await flush(50)
  host.emitTurn(laneId)
  await flush()
  expect(a.trace()).toEqual(SLOW_FIRST)
  expect(b.texts.length).toBe(147)
  expect(digest([...a.texts, ...b.texts])).toBe('5b55f262cb9c8c56')
})

it('keeps separate Host instances independent', async () => {
  const one = makeHost({ commandDelayMs: 1 }),
    two = makeHost({ commandDelayMs: 1 })
  const a = await viewer(one),
    b = await viewer(two)
  await createLane(a, rid(1))
  a.send({
    type: 'command',
    requestId: rid(2),
    laneId: laneIdOf(1),
    fence: 1,
    op: { type: 'abort' },
  })
  b.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
  b.send({ type: 'receipt-status', requestId: rid(1) })
  await flush(1)
  expect([one.executions(), two.executions()]).toEqual([1, 0])
  one.stop()
  await flush()
  expect(() => two.emitTurn(laneIdOf(1))).toThrow('Unknown lane')
  await createLane(b, rid(1))
  expect([a.closes, b.closes, b.trace()]).toEqual(INDEPENDENT)
})

it('rejects invalid limits and repository lists, and applies lowered limits', async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, HOST_LIMITS.subscriptionsPerConnection + 1])
    expect(() => makeHost({ limits: { subscriptionsPerConnection: value } })).toThrow(
      'Invalid limit',
    )
  const repositories = [REPOSITORY, { ...REPOSITORY, id: 'fedcba9876543210' }]
  expect(() => makeHost({ repositories, limits: { repositoriesPerHost: 1 } })).toThrow(
    'Too many repositories',
  )
  let epochs = 0
  expect(() =>
    createFakeHost({
      expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
      verify: () => true,
      sign: () => new Uint8Array(64),
      id: () => laneIdOf(1),
      epoch: () => String(++epochs),
      limits: { lanesPerHost: 0 },
    }),
  ).toThrow('Invalid limit')
  expect(epochs).toBe(0)
  const host = makeHost({
    limits: { subscriptionsPerConnection: 1, lanesPerHost: 1, pendingEvents: 2 },
  })
  const a = await viewer(host)
  a.send({ type: 'subscribe', id: 'one', topic: 'lanes' })
  a.send({ type: 'subscribe', id: 'two', topic: 'lanes' })
  await createLane(a, rid(1))
  await createLane(a, rid(2))
  expect(() => host.emitTurn(laneIdOf(1))).toThrow('Scripted pending limit exceeded')
  expect(() => host.emitTurn(laneIdOf(9))).toThrow('Unknown lane')
  expect(a.trace()).toEqual(LIMITS)
})

it('replaces and clears stored UI keys within their limits and hydrates only the latest state', async () => {
  const host = makeHost({ limits: { uiStatusKeys: 2, uiWidgetKeys: 1 } })
  const a = await viewer(host)
  await createLane(a, rid(1))
  const laneId = laneIdOf(1)
  for (const request of [status('a', '1'), status('b', '1'), status('a', '2')])
    host.emitUi(laneId, request)
  expect(() => host.emitUi(laneId, status('c', '1'))).toThrow('UI keys full')
  host.emitUi(laneId, status('b'))
  host.emitUi(laneId, status('c', '1'))
  host.emitUi(laneId, widget('w', ['1']))
  expect(() => host.emitUi(laneId, widget('x', ['1']))).toThrow('UI keys full')
  host.emitUi(laneId, widget('w', []))
  host.emitUi(laneId, widget('x', ['2']))
  host.emitUi(laneId, title('One'))
  host.emitUi(laneId, title('Two'))
  host.emitUi(laneId, notice)
  a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
  await flush()
  const snapshot = JSON.parse(a.texts.at(-1) ?? '{}').snapshot
  expect(snapshot.ui).toEqual([
    status('a', '2'),
    status('c', '1'),
    widget('x', ['2']),
    title('Two'),
  ])
  expect([snapshot.cursor, a.trace().slice(-1)]).toEqual(UI)
})
