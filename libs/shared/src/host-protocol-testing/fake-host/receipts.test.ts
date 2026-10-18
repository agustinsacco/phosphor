import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantClient, GrantPayload } from '../../host-grant'
import type { FrameSocket, HostFrame, Receipt } from '../../host-protocol'
import { deliver, forget, prune, rejected, rejectStored } from './receipts'
import {
  createFakeHostState,
  type Connection,
  type FakeHostState,
  type Lane,
  type Limits,
  type Stored,
} from './state'

const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }

function host(limits: Partial<Limits> = {}): FakeHostState {
  return createFakeHostState({
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => 'id',
    epoch: () => 'epoch',
    limits,
  })
}
function grant(client: GrantClient): GrantPayload {
  return {
    v: 1,
    iss: 'https://control.test',
    kid: 'key',
    sub: 'owner',
    sid: 'session',
    hostId: 'host',
    epoch: 1,
    client,
    caps: ['sessions.read', 'sessions.control'],
    iat: 0,
    exp: 300,
    jti: '0123456789abcdef',
  }
}
function socketFor(state: FakeHostState, client: GrantClient | null) {
  const frames: HostFrame[] = []
  const socket: FrameSocket = {
    send: (text) => void frames.push(JSON.parse(text)),
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    isOpen: () => true,
    bufferedBytes: () => 0,
  }
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const c: Connection = {
    socket,
    grant: client ? grant(client) : null,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  }
  state.connections.add(c)
  return { c, receipts: () => frames.flatMap((f) => (f.type === 'receipt' ? [f.receipt] : [])) }
}
function store(state: FakeHostState, id: string, receipt: Receipt, finishedAt?: number): Stored {
  const stored: Stored = { clientId: FIRST.id, hash: id, receipt }
  if (finishedAt !== undefined) stored.finishedAt = finishedAt
  state.receipts.set(id, stored)
  return stored
}
const done = (requestId: string): Receipt => ({ requestId, status: 'done' })
const pending = (requestId: string): Receipt => ({ requestId, status: 'pending' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('forget and prune', () => {
  it('forgets a receipt and every connection interest in it', () => {
    const state = host()
    const a = socketFor(state, FIRST),
      b = socketFor(state, SECOND)
    store(state, 'r', done('r'))
    a.c.wanted.add('r')
    b.c.delivered.add('r')
    a.c.wanted.add('other')
    forget(state, 'r')
    expect([state.receipts.has('r'), [...a.c.wanted], b.c.delivered.size]).toEqual([
      false,
      ['other'],
      0,
    ])
  })

  it('expires finished receipts strictly after the TTL and keeps pending ones', () => {
    const state = host({ receiptTtlMs: 20 })
    store(state, 'boundary', done('boundary'), Date.now() - 20)
    store(state, 'expired', done('expired'), Date.now() - 21)
    store(state, 'pending', pending('pending'))
    prune(state)
    expect([...state.receipts.keys()]).toEqual(['boundary', 'pending'])
  })

  it('keeps the newest finished receipts by insertion order, not counting pending ones', () => {
    const state = host({ receiptsKept: 2 })
    store(state, 'one', done('one'), Date.now())
    store(state, 'started', pending('started'))
    store(state, 'two', done('two'), Date.now())
    store(state, 'three', done('three'), Date.now())
    prune(state)
    expect([...state.receipts.keys()]).toEqual(['started', 'two', 'three'])
  })
})

describe('deliver', () => {
  it('reaches only interested sockets of the owning client, repeating pending', () => {
    const state = host()
    const a = socketFor(state, FIRST),
      idle = socketFor(state, FIRST),
      other = socketFor(state, SECOND),
      anonymous = socketFor(state, null)
    for (const s of [a, other, anonymous]) s.c.wanted.add('r')
    const stored = store(state, 'r', pending('r'))
    deliver(state, 'r', stored)
    deliver(state, 'r', stored)
    expect([a, idle, other, anonymous].map((s) => s.receipts().length)).toEqual([2, 0, 0, 0])
    expect([stored.finishedAt, a.c.wanted.has('r'), a.c.delivered.has('r')]).toEqual([
      undefined,
      true,
      false,
    ])
  })

  it('delivers a terminal receipt once per socket and stamps its finish time once', () => {
    const state = host()
    const a = socketFor(state, FIRST),
      b = socketFor(state, FIRST)
    a.c.wanted.add('r')
    b.c.wanted.add('r')
    const stored = store(state, 'r', done('r'))
    deliver(state, 'r', stored)
    vi.advanceTimersByTime(5)
    b.c.wanted.add('r')
    deliver(state, 'r', stored)
    expect([a.receipts(), b.receipts()]).toEqual([[done('r')], [done('r')]])
    expect([stored.finishedAt, a.c.wanted.has('r'), a.c.delivered.has('r')]).toEqual([
      1_000_000,
      false,
      true,
    ])
  })

  it('prunes before sending, so a terminal receipt over the count cap is still sent', () => {
    const state = host({ receiptsKept: 1 })
    const a = socketFor(state, FIRST)
    store(state, 'old', done('old'), Date.now())
    const stored = store(state, 'r', done('r'))
    a.c.wanted.add('r')
    deliver(state, 'r', stored)
    expect([...state.receipts.keys()]).toEqual(['r'])
    expect(a.receipts()).toEqual([done('r')])
  })
})

describe('refusals', () => {
  const lane = laneLike({ fence: 3, controller: null })

  it('answers an unstored refusal to the asking socket only, with control when given', () => {
    const state = host()
    const a = socketFor(state, FIRST),
      b = socketFor(state, FIRST)
    b.c.wanted.add('r')
    rejected(state, a.c, 'r', 'conflict')
    rejected(state, a.c, 'r', 'stale-fence', lane)
    expect(a.receipts()).toEqual([
      { requestId: 'r', status: 'rejected', code: 'conflict' },
      {
        requestId: 'r',
        status: 'rejected',
        code: 'stale-fence',
        control: { fence: 3, controller: null },
      },
    ])
    expect([b.receipts(), state.receipts.size]).toEqual([[], 0])
  })

  it('settles a stored command as refused and delivers it to interested sockets', () => {
    const state = host()
    const a = socketFor(state, FIRST)
    a.c.wanted.add('r')
    const stored = store(state, 'r', pending('r'))
    rejectStored(state, stored, 'not-controller', lane)
    const refused = {
      requestId: 'r',
      status: 'rejected',
      code: 'not-controller',
      control: { fence: 3, controller: null },
    }
    expect([stored.receipt, a.receipts()]).toEqual([refused, [refused]])
    expect(stored.finishedAt).toBe(1_000_000)
  })
})

/** Refusals read only a lane's control, so the rest of the lane is irrelevant here. */
function laneLike(control: Lane['summary']['control']): Lane {
  return {
    summary: {
      laneId: 'lane',
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
      control,
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
}
