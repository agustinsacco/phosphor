import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantClient, GrantPayload } from '../../host-grant'
import {
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type LaneOp,
  type Receipt,
} from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import { createFakeHost, type FakeHostOptions } from '../fake-host'
import { createLoopbackPair } from '../loopback'
import { admit, command } from './commands'
import {
  createFakeHostState,
  type Command,
  type Connection,
  type FakeHostState,
  type Limits,
} from './state'

const ISSUER = 'https://control.test'
const HOST_ID = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000a2'
const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }
const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/test/repository' }
const LANE = '00000000-0000-4000-8000-000000000001'
const rid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const hosts: ReturnType<typeof createFakeHost>[] = []

/** Public-entry harness: grants are looked up by token, so no signing is involved. */
function harness(extra: Partial<FakeHostOptions> = {}) {
  let ids = 0
  const grants = new Map<string, GrantPayload>()
  const host = createFakeHost({
    expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
    verify: () => false,
    verifyGrant: (token) => grants.get(token) ?? null,
    sign: () => new Uint8Array(64),
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    epoch: () => 'epoch',
    repositories: [REPOSITORY],
    ...extra,
  })
  hosts.push(host)
  async function viewer(
    client = FIRST,
    caps: HostCapability[] = ['sessions.read', 'sessions.control'],
  ) {
    const iat = Math.floor(Date.now() / 1000)
    const token = `grant-${grants.size}`
    grants.set(token, {
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
    const pair = createLoopbackPair()
    const frames: HostFrame[] = []
    pair.client.onMessage((text) => frames.push(JSON.parse(text)))
    host.attach(pair.server)
    pair.client.send(JSON.stringify({ type: 'auth', grant: token, challenge: 'c'.repeat(64) }))
    await flush()
    const send = (frame: ClientFrame) => pair.client.send(JSON.stringify(frame))
    return {
      frames,
      send,
      command: (n: number, op: LaneOp, fence: number | null = 1, laneId: string | null = LANE) =>
        send({
          type: 'command',
          requestId: rid(n),
          op,
          ...(laneId === null ? {} : { laneId }),
          ...(fence === null ? {} : { fence }),
        }),
      receipts: () => frames.flatMap((f) => (f.type === 'receipt' ? [brief(f.receipt)] : [])),
      events: () => frames.flatMap((f) => (f.type === 'event' ? [f.event.kind] : [])),
    }
  }
  return { host, viewer }
}
function brief(r: Receipt): string {
  const tail =
    r.status === 'rejected'
      ? `:${r.code}${r.control ? `:f${r.control.fence}` : ''}`
      : r.status === 'done' && r.fence !== undefined
        ? `:f${r.fence}`
        : ''
  return `${r.requestId.slice(-2)}:${r.status}${tail}`
}
const create: LaneOp = { type: 'lane.create', repositoryId: REPOSITORY.id, worktree: null }
const prompt: LaneOp = { type: 'prompt', message: 'Hello' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  await flush()
  vi.useRealTimers()
})

describe('command admission through createFakeHost', () => {
  it('deduplicates before the caps, and leaves cap refusals unstored', async () => {
    const { host, viewer } = harness({
      commandDelayMs: 10,
      limits: { pendingCommandsPerConnection: 1 },
    })
    const a = await viewer()
    a.command(1, create, null, null)
    await flush()
    a.command(2, prompt)
    a.command(2, prompt)
    a.command(3, { type: 'abort' })
    await flush(10)
    a.command(3, { type: 'abort' })
    await flush(10)
    expect(a.receipts()).toEqual([
      '01:done:f1',
      '02:pending',
      '03:rejected:too-many-requests',
      '02:done:f1',
      '03:done:f1',
    ])
    expect(host.executions()).toBe(2)
  })

  it('refuses reuse by another client or with another body as an unstored conflict', async () => {
    const { host, viewer } = harness({ commandDelayMs: 10 })
    const a = await viewer(),
      b = await viewer(SECOND)
    a.command(1, create, null, null)
    await flush()
    a.command(2, prompt)
    b.command(2, prompt)
    a.command(2, { type: 'abort' })
    a.command(2, prompt, 2)
    await flush(10)
    expect(a.receipts()).toEqual([
      '01:done:f1',
      '02:rejected:conflict',
      '02:rejected:conflict',
      '02:done:f1',
    ])
    expect(b.receipts()).toEqual(['02:rejected:conflict'])
    expect(host.executions()).toBe(1)
  })

  it('stores a forbidden refusal and replays it for a retry or a lookup', async () => {
    const { host, viewer } = harness()
    const reader = await viewer(FIRST, ['sessions.read'])
    reader.command(1, create, null, null)
    reader.command(1, create, null, null)
    reader.send({ type: 'receipt-status', requestId: rid(1) })
    await flush()
    expect(reader.receipts()).toEqual([
      '01:rejected:forbidden',
      '01:rejected:forbidden',
      '01:rejected:forbidden',
    ])
    expect(host.executions()).toBe(0)
  })

  it('counts started receipts across connections against the busy cap', async () => {
    const { viewer } = harness({ commandDelayMs: 10, limits: { receiptsKept: 1 } })
    const a = await viewer(),
      b = await viewer()
    a.command(1, create, null, null)
    await flush()
    a.command(2, prompt)
    b.command(3, { type: 'abort' })
    await flush(10)
    b.command(3, { type: 'abort' })
    await flush(10)
    expect(a.receipts()).toEqual(['01:done:f1', '02:done:f1'])
    expect(b.receipts()).toEqual(['03:rejected:busy', '03:done:f1'])
  })

  it.for([
    [HOST_LIMITS.commandAnswerMs - 1, 'done:f1'],
    [HOST_LIMITS.commandAnswerMs, 'done:f1'],
    [HOST_LIMITS.commandAnswerMs + 1, 'unknown'],
  ] as const)(
    'settles once when completion takes %i ms against the deadline',
    async ([delay, end]) => {
      const { host, viewer } = harness({ commandDelayMs: delay })
      const a = await viewer()
      a.command(1, create, null, null)
      await flush()
      a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
      a.command(2, prompt)
      await flush(HOST_LIMITS.commandAnswerMs + 10)
      a.send({ type: 'receipt-status', requestId: rid(2) })
      await flush()
      expect(a.receipts()).toEqual(['01:done:f1', `02:${end}`, `02:${end}`])
      expect(a.events().length).toBe(end === 'unknown' ? 0 : 7)
      expect(host.executions()).toBe(1)
    },
  )

  it('answers unknown for a lane that failed in flight and for a restart-interrupted command', async () => {
    const { host, viewer } = harness({ commandDelayMs: 10 })
    const a = await viewer()
    a.command(1, create, null, null)
    await flush()
    a.command(2, prompt)
    a.command(3, { type: 'abort' })
    await flush()
    host.failLane(LANE)
    await flush(10)
    a.command(4, { type: 'lane.resume' })
    await flush()
    host.restart()
    await flush(HOST_LIMITS.commandAnswerMs)
    const b = await viewer()
    b.send({ type: 'receipt-status', requestId: rid(4) })
    b.command(5, { type: 'abort' })
    await flush(10)
    expect(a.receipts()).toEqual(['01:done:f1', '02:unknown', '03:unknown'])
    expect(b.receipts()).toEqual(['04:unknown', '05:done:f1'])
    expect(host.executions()).toBe(4)
  })
})

describe('lane operations through createFakeHost', () => {
  it('creates lanes within the Host cap and refuses unknown repositories or lanes', async () => {
    const { viewer } = harness({ limits: { lanesPerHost: 1 } })
    const a = await viewer()
    a.command(1, { ...create, repositoryId: 'fedcba9876543210' }, null, null)
    a.command(2, create, null, null)
    a.command(3, create, null, null)
    a.command(4, create, 1)
    a.command(5, { type: 'abort' }, 1, '00000000-0000-4000-8000-0000000000ff')
    a.command(6, { type: 'abort' }, 1, null)
    await flush()
    expect(a.receipts()).toEqual([
      '01:rejected:bad-request',
      '02:done:f1',
      '03:rejected:too-many-requests',
      '04:rejected:bad-request',
      '05:rejected:unknown-lane',
      '06:rejected:unknown-lane',
    ])
  })

  it('fences control, claims an uncontrolled lane and lets anyone take control or mark read', async () => {
    const { viewer } = harness()
    const a = await viewer(),
      b = await viewer(SECOND)
    a.command(1, create, null, null)
    await flush()
    b.command(2, { type: 'abort' })
    await flush()
    a.command(3, { type: 'abort' }, null)
    a.command(4, { type: 'control.release' })
    a.command(5, { type: 'control.release' }, 2)
    await flush(1)
    b.command(6, { type: 'lane.markRead', upTo: 5 }, 9)
    b.command(7, { type: 'abort' }, 2)
    await flush(1)
    b.command(8, { type: 'control.take' }, 99)
    await flush(1)
    a.command(9, { type: 'abort' }, 4)
    await flush(1)
    expect(a.receipts()).toEqual([
      '01:done:f1',
      '03:rejected:stale-fence:f1',
      '05:rejected:not-controller:f2',
      '04:done:f2',
      '09:rejected:not-controller:f4',
    ])
    expect(b.receipts()).toEqual([
      '02:rejected:not-controller:f1',
      '06:done:f3',
      '07:done:f3',
      '08:done:f4',
    ])
  })

  it('stops and resumes lanes, refusing other operations while stopped or failed', async () => {
    const { host, viewer } = harness()
    const a = await viewer()
    a.command(1, create, null, null)
    await flush()
    a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    a.command(2, { type: 'lane.stop' })
    a.command(3, prompt)
    a.command(4, { type: 'set_session_name', name: 'Name' })
    a.command(5, { type: 'lane.markRead', upTo: 1 })
    a.command(6, { type: 'lane.resume' })
    await flush(1)
    host.failLane(LANE)
    a.command(7, { type: 'set_model', provider: 'p', modelId: 'm' })
    await flush(1)
    expect(a.receipts()).toEqual([
      '01:done:f1',
      '03:rejected:lane-stopped',
      '04:rejected:lane-stopped',
      '02:done:f1',
      '05:done:f1',
      '06:done:f1',
      '07:rejected:lane-stopped',
    ])
    expect(a.events()).toEqual(['summary', 'summary', 'summary', 'pi', 'summary'])
  })

  it('resolves only open dialogs, publishing the resolution before the summary', async () => {
    const { host, viewer } = harness()
    const a = await viewer()
    a.command(1, create, null, null)
    await flush()
    host.openDialog(LANE, 'one')
    host.openDialog(LANE, 'two')
    a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: LANE })
    const answer = (id: string): LaneOp => ({
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id, confirmed: true },
    })
    a.command(2, answer('missing'))
    a.command(3, answer('one'))
    a.command(4, answer('two'))
    a.command(5, { type: 'set_thinking_level', level: 'high' })
    await flush(1)
    a.send({ type: 'unsubscribe', id: 'lane' })
    a.send({ type: 'subscribe', id: 'again', topic: 'lane', laneId: LANE })
    await flush()
    const summaries = a.frames.flatMap((f) =>
      f.type === 'event' && f.event.kind === 'summary' ? [f.event.summary.activity] : [],
    )
    expect(a.receipts().slice(1)).toEqual([
      '02:rejected:bad-request',
      '03:done:f1',
      '04:done:f1',
      '05:done:f1',
    ])
    expect(a.events()).toEqual(['dialog-resolved', 'summary', 'dialog-resolved', 'summary'])
    expect(summaries).toEqual(['needs-input', 'idle'])
    expect(a.frames.at(-1)).toMatchObject({
      type: 'snapshot',
      snapshot: { dialogs: [], state: { thinkingLevel: 'high' } },
    })
  })
})

describe('command module', () => {
  function state(limits: Partial<Limits> = {}, commandDelayMs?: number) {
    return createFakeHostState({
      expectations: { iss: ISSUER, hostId: HOST_ID, owner: OWNER, epoch: 1 },
      verify: () => false,
      sign: () => new Uint8Array(64),
      id: () => LANE,
      epoch: () => 'epoch',
      repositories: [REPOSITORY],
      limits,
      ...(commandDelayMs === undefined ? {} : { commandDelayMs }),
    })
  }
  function connection(s: FakeHostState, client: GrantClient) {
    const frames: HostFrame[] = []
    const authTimer = setTimeout(() => undefined, 0)
    clearTimeout(authTimer)
    const iat = Math.floor(Date.now() / 1000)
    const c: Connection = {
      socket: {
        send: (text) => void frames.push(JSON.parse(text)),
        close: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
        isOpen: () => true,
        bufferedBytes: () => 0,
      },
      grant: {
        v: 1,
        iss: ISSUER,
        kid: 'key',
        sub: OWNER,
        sid: 'session',
        hostId: HOST_ID,
        epoch: 1,
        client,
        caps: ['sessions.read', 'sessions.control'],
        iat,
        exp: iat + 300,
        jti: '0123456789abcdef',
      },
      subscriptions: new Map(),
      wanted: new Set(),
      delivered: new Set(),
      pending: 0,
      calls: 0,
      stale: new Set(),
      authTimer,
    }
    s.connections.add(c)
    return {
      c,
      receipts: () => frames.flatMap((f) => (f.type === 'receipt' ? [brief(f.receipt)] : [])),
    }
  }
  const frame = (n: number, op: LaneOp, fence?: number): Command => ({
    type: 'command',
    requestId: rid(n),
    op,
    ...(op.type === 'lane.create' ? {} : { laneId: LANE }),
    ...(fence === undefined ? {} : { fence }),
  })

  it('stores a new command as pending and wanted, and answers a same-id retry from the store', () => {
    const s = state()
    const a = connection(s, FIRST),
      b = connection(s, SECOND)
    const grant = a.c.grant
    if (!grant) throw new Error('No grant')
    const stored = admit(s, a.c, frame(1, prompt, 1), grant)
    expect(stored).toEqual({
      clientId: FIRST.id,
      hash: expect.any(String),
      receipt: { requestId: rid(1), status: 'pending' },
    })
    expect(stored?.hash).toBe(JSON.stringify({ laneId: LANE, fence: 1, op: prompt }))
    expect([...a.c.wanted]).toEqual([rid(1)])
    a.c.wanted.clear()
    expect(admit(s, a.c, frame(1, prompt, 1), grant)).toBeNull()
    expect(admit(s, a.c, frame(1, prompt, 2), grant)).toBeNull()
    const other = b.c.grant
    if (!other) throw new Error('No grant')
    expect(admit(s, b.c, frame(1, prompt, 1), other)).toBeNull()
    expect([a.receipts(), b.receipts(), [...a.c.wanted]]).toEqual([
      ['01:pending', '01:rejected:conflict'],
      ['01:rejected:conflict'],
      [rid(1)],
    ])
    expect(s.receipts.size).toBe(1)
  })

  it('refuses over the connection cap before the Host-wide started cap, unstored', () => {
    const s = state({ pendingCommandsPerConnection: 1, receiptsKept: 1 })
    const a = connection(s, FIRST)
    const grant = a.c.grant
    if (!grant) throw new Error('No grant')
    a.c.pending = 1
    expect(admit(s, a.c, frame(1, prompt, 1), grant)).toBeNull()
    a.c.pending = 0
    s.receipts.set(rid(9), {
      clientId: SECOND.id,
      hash: '',
      receipt: { requestId: rid(9), status: 'pending' },
    })
    expect(admit(s, a.c, frame(2, prompt, 1), grant)).toBeNull()
    expect(a.receipts()).toEqual(['01:rejected:too-many-requests', '02:rejected:busy'])
    expect([...s.receipts.keys()]).toEqual([rid(9)])
  })

  it.for([
    [HOST_LIMITS.commandAnswerMs - 1, '01:done:f1'],
    [HOST_LIMITS.commandAnswerMs + 1, '01:unknown'],
  ] as const)('settles a %i ms command once, clearing both timers', async ([delay, settled]) => {
    const s = state({}, delay)
    const a = connection(s, FIRST)
    command(s, a.c, frame(0, create), true)
    command(s, a.c, frame(1, { type: 'abort' }, 1), true)
    expect([a.c.pending, s.executions, s.timers.size]).toEqual([1, 1, 2])
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs + 1)
    expect(a.receipts()).toEqual(['00:done:f1', settled])
    expect([a.c.pending, s.executions, s.timers.size]).toEqual([0, 1, 0])
  })

  it('settles nothing once the epoch has changed', async () => {
    const s = state({}, 5)
    const a = connection(s, FIRST)
    command(s, a.c, frame(0, create), true)
    command(s, a.c, frame(1, { type: 'abort' }, 1), true)
    s.epoch = 'restarted'
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs + 1)
    expect(a.receipts()).toEqual(['00:done:f1'])
    expect([a.c.pending, s.receipts.get(rid(1))?.receipt.status]).toEqual([1, 'pending'])
  })

  it('stores a forbidden refusal when the connection may not control lanes', () => {
    const s = state()
    const a = connection(s, FIRST)
    command(s, a.c, frame(1, create), false)
    expect(a.receipts()).toEqual(['01:rejected:forbidden'])
    expect(s.receipts.get(rid(1))?.receipt).toEqual({
      requestId: rid(1),
      status: 'rejected',
      code: 'forbidden',
    })
    expect([s.lanes.size, s.executions]).toEqual([0, 0])
  })

  it('ignores a command from a connection without a grant', () => {
    const s = state()
    const a = connection(s, FIRST)
    a.c.grant = null
    command(s, a.c, frame(1, create), true)
    expect([a.receipts(), s.receipts.size, a.c.wanted.size]).toEqual([[], 0, 0])
  })
})
