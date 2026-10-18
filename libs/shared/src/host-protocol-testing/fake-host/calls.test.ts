import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantPayload } from '../../host-grant'
import type { ClientFrame, FrameSocket, HostFrame } from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import { call, laneRead, paramsLane } from './calls'
import {
  createFakeHostState,
  type Connection,
  type FakeHostState,
  type Lane,
  type Limits,
} from './state'

const LANE = '00000000-0000-4000-8000-000000000001'

function host(limits: Partial<Limits> = {}): FakeHostState {
  return createFakeHostState({
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => LANE,
    epoch: () => 'epoch',
    limits,
  })
}
function grant(caps: HostCapability[]): GrantPayload {
  return {
    v: 1,
    iss: 'https://control.test',
    kid: 'key',
    sub: 'owner',
    sid: 'session',
    hostId: 'host',
    epoch: 1,
    client: { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' },
    caps,
    iat: 0,
    exp: 300,
    jti: '0123456789abcdef',
  }
}
function viewer(state: FakeHostState, caps: HostCapability[] = ['sessions.read']) {
  const wire = { open: true, frames: [] as HostFrame[], closes: [] as string[] }
  const socket: FrameSocket = {
    send: (text) => void wire.frames.push(JSON.parse(text)),
    close: (code, reason) => {
      wire.open = false
      wire.closes.push(`${code} ${reason}`)
    },
    onMessage: () => undefined,
    onClose: () => undefined,
    isOpen: () => wire.open,
    bufferedBytes: () => 0,
  }
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const c: Connection = {
    socket,
    grant: grant(caps),
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  }
  const results = () =>
    wire.frames.flatMap((f) =>
      f.type === 'result' ? [`${f.id} ${f.ok ? 'ok' : f.error.code}`] : [],
    )
  return { c, wire, results }
}
function addLane(state: FakeHostState): Lane {
  const lane: Lane = {
    summary: {
      laneId: LANE,
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
      control: { fence: 1, controller: null },
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
  state.lanes.set(LANE, lane)
  return lane
}
const frame = (
  id: string,
  method: string,
  params: unknown = { laneId: LANE },
): Extract<ClientFrame, { type: 'call' }> => ({ type: 'call', id, method, params })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('call', () => {
  it('checks authority, method, repositories, the cap, then the lane, in that order', () => {
    const state = host({ pendingCommandsPerConnection: 1 })
    addLane(state)
    const blind = viewer(state, ['sessions.control'])
    call(state, blind.c, frame('a', 'other.method'))
    const v = viewer(state)
    call(state, v.c, frame('b', 'other.method'))
    call(state, v.c, frame('c', 'lane.state', {}))
    call(state, v.c, frame('d', 'lane.state', { laneId: '00000000-0000-4000-8000-0000000000ff' }))
    v.c.calls = 1
    call(state, v.c, frame('e', 'host.repositories', {}))
    call(state, v.c, frame('f', 'lane.state', {}))
    expect([blind.results(), v.results(), v.wire.closes]).toEqual([
      ['a forbidden'],
      ['b unsupported', 'c bad-request', 'd unknown-lane', 'e ok'],
      ['4429 Too many calls'],
    ])
  })

  it('answers a lane read on the next tick, tracking the call and its timer', async () => {
    const state = host()
    addLane(state)
    const v = viewer(state)
    call(state, v.c, frame('state', 'lane.state'))
    expect([v.results(), v.c.calls, state.timers.size]).toEqual([[], 1, 1])
    await vi.advanceTimersByTimeAsync(0)
    expect([v.results(), v.c.calls, state.timers.size]).toEqual([['state ok'], 0, 0])
  })

  it('drops the answer after read authority or the socket is gone, still releasing the slot', async () => {
    const state = host()
    addLane(state)
    const revoked = viewer(state),
      closed = viewer(state)
    call(state, revoked.c, frame('a', 'lane.state'))
    call(state, closed.c, frame('b', 'lane.state'))
    revoked.c.grant = grant(['sessions.control'])
    closed.wire.open = false
    await vi.advanceTimersByTimeAsync(0)
    expect([revoked.results(), closed.results(), revoked.c.calls, closed.c.calls]).toEqual([
      [],
      [],
      0,
      0,
    ])
  })
})

describe('laneRead', () => {
  it('shares the transcript for messages and builds state and stats now', () => {
    const state = host()
    const lane = addLane(state)
    const messages = laneRead(state, 'lane.messages', LANE, lane)
    const live = laneRead(state, 'lane.state', LANE, lane)
    const stats = laneRead(state, 'lane.stats', LANE, lane)
    lane.messages.push({ role: 'user', content: 'Hi', timestamp: 0 })
    expect(messages).toEqual({ messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] })
    expect(live).toMatchObject({ messageCount: 0 })
    expect(stats).toEqual({
      sessionId: LANE,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    })
    expect([
      laneRead(state, 'lane.models', LANE, lane),
      laneRead(state, 'lane.commands', LANE, lane),
    ]).toEqual([{ models: [] }, { commands: [] }])
    lane.summary = { ...lane.summary, activity: 'stopped' }
    expect(laneRead(state, 'lane.state', LANE, lane)).toBeNull()
  })
})

it('reads a lane id only from an object with a UUID laneId', () => {
  expect([null, 'x', {}, { laneId: 'lane' }, { laneId: 7 }].map(paramsLane)).toEqual([
    null,
    null,
    null,
    null,
    null,
  ])
  expect(paramsLane({ laneId: LANE, extra: true })).toBe(LANE)
})
