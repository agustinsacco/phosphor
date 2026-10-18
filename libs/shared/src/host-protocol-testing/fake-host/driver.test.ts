import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRANT_LIMITS, type GrantPayload } from '../../host-grant'
import { HOST_LIMITS, type FrameSocket } from '../../host-protocol'
import type { ExtensionUIRequest } from '../../rpc'
import {
  emitTurn,
  emitUi,
  failLane,
  laneOf,
  openDialog,
  restart,
  revokeClient,
  revokeSession,
  stop,
  uiBound,
  uiSlot,
} from './driver'
import { createFakeHostState, type FakeHostState, type Lane, type Limits } from './state'

const LANE = '00000000-0000-4000-8000-000000000001'

function host(limits: Partial<Limits> = {}) {
  let epochs = 0
  return createFakeHostState({
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => LANE,
    epoch: () => `epoch-${++epochs}`,
    limits,
  })
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
/** A socket that only records closes; sid and client id come from the given grant fields. */
function socket(state: FakeHostState, sid: string, clientId: string) {
  const closes: string[] = []
  const frameSocket: FrameSocket = {
    send: () => undefined,
    close: (code, reason) => void closes.push(`${code} ${reason}`),
    onMessage: () => undefined,
    onClose: () => undefined,
    isOpen: () => true,
    bufferedBytes: () => 0,
  }
  const authTimer = setTimeout(() => undefined, 0)
  clearTimeout(authTimer)
  const grant: GrantPayload = {
    v: 1,
    iss: 'https://control.test',
    kid: 'key',
    sub: 'owner',
    sid,
    hostId: 'host',
    epoch: 1,
    client: { id: clientId, label: 'Viewer' },
    caps: ['sessions.read'],
    iat: 0,
    exp: 300,
    jti: '0123456789abcdef',
  }
  state.connections.add({
    socket: frameSocket,
    grant,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  })
  return closes
}
const status = (key: string, text?: string): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 's',
  method: 'setStatus',
  statusKey: key,
  statusText: text,
})
const widget = (key: string, lines?: string[]): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id: 'w',
  method: 'setWidget',
  widgetKey: key,
  widgetLines: lines,
})
const title: ExtensionUIRequest = {
  type: 'extension_ui_request',
  id: 't',
  method: 'setTitle',
  title: 'T',
}
const notice: ExtensionUIRequest = {
  type: 'extension_ui_request',
  id: 'n',
  method: 'notify',
  message: 'm',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UI state', () => {
  it('keys status, widget and title requests and nothing else', () => {
    expect(
      [status('a', 'x'), status('a'), widget('w', ['l']), widget('w', []), widget('w'), title].map(
        uiSlot,
      ),
    ).toEqual([
      { prefix: 'status:', key: 'status:a', clear: false },
      { prefix: 'status:', key: 'status:a', clear: true },
      { prefix: 'widget:', key: 'widget:w', clear: false },
      { prefix: 'widget:', key: 'widget:w', clear: true },
      { prefix: 'widget:', key: 'widget:w', clear: true },
      { prefix: 'title:', key: 'title:', clear: false },
    ])
    expect(uiSlot(notice)).toBeNull()
    const state = host({ uiStatusKeys: 2, uiWidgetKeys: 3 })
    expect([
      uiBound(state, 'status:'),
      uiBound(state, 'widget:'),
      uiBound(state, 'title:'),
    ]).toEqual([2, 3, 1])
  })

  it('replaces in place, clears, and refuses a new key at the bound before publishing', () => {
    const state = host({ uiStatusKeys: 2 })
    const lane = addLane(state)
    for (const request of [status('a', '1'), status('b', '1'), status('a', '2'), title, notice])
      emitUi(state, LANE, request)
    expect([...lane.ui.entries()]).toEqual([
      ['status:a', status('a', '2')],
      ['status:b', status('b', '1')],
      ['title:', title],
    ])
    expect(() => emitUi(state, LANE, status('c', '1'))).toThrow('UI keys full')
    expect(lane.seq).toBe(5)
    emitUi(state, LANE, status('a'))
    emitUi(state, LANE, status('c', '1'))
    expect([[...lane.ui.keys()], lane.seq]).toEqual([['status:b', 'title:', 'status:c'], 7])
  })

  it('refuses a stored request over the outbound frame limit after the key check', () => {
    const state = host({ uiStatusKeys: 1 })
    const lane = addLane(state)
    const huge = status('a', 'x'.repeat(HOST_LIMITS.outboundFrameBytes))
    expect(() => emitUi(state, LANE, huge)).toThrow('UI request too large')
    emitUi(state, LANE, status('b', '1'))
    expect(() => emitUi(state, LANE, huge)).toThrow('UI keys full')
    expect([[...lane.ui.keys()], lane.seq]).toEqual([['status:b'], 1])
  })
})

describe('lane scripting', () => {
  it('looks lanes up by id and runs one turn', () => {
    const state = host()
    const lane = addLane(state)
    expect(laneOf(state, LANE)).toBe(lane)
    expect(() => laneOf(state, 'missing')).toThrow('Unknown lane')
    expect(emitTurn(state, LANE)).toEqual({ messages: 1, turns: 1 })
  })

  it('opens dialogs up to the pending limit and asks for input with attention', () => {
    const state = host({ pendingEvents: 1 })
    const lane = addLane(state)
    openDialog(state, LANE, 'one')
    expect(() => openDialog(state, LANE, 'two')).toThrow('Too many dialogs')
    expect(lane.dialogs.map((d) => d.id)).toEqual(['one'])
    expect(lane.summary).toMatchObject({ activity: 'needs-input', attention: 1 })
    expect(state.attention.map((a) => a.event.kind)).toEqual(['needs-input'])
    expect(lane.events.map((e) => e.event.kind)).toEqual(['pi', 'summary'])
  })

  it('fails a lane with an unexpected exit and failure attention', () => {
    const state = host()
    const lane = addLane(state)
    failLane(state, LANE)
    expect(lane.summary.activity).toBe('failed')
    expect(lane.events[0]?.event).toEqual({
      kind: 'pi',
      push: { kind: 'exit', code: 1, signal: null, expected: false },
    })
    expect(state.attention.map((a) => a.event.kind)).toEqual(['failed'])
  })
})

describe('Host lifecycle', () => {
  it('restarts into a new epoch, ending pending receipts, timers, replay and sockets', () => {
    const state = host()
    const lane = addLane(state)
    emitTurn(state, LANE)
    lane.pending.push({ type: 'agent_start' })
    const closes = socket(state, 'session', 'client')
    const fired: string[] = []
    state.timers.add(setTimeout(() => fired.push('timer'), 10))
    state.receipts.set('p', {
      clientId: 'client',
      hash: '',
      receipt: { requestId: 'p', status: 'pending' },
    })
    state.receipts.set('d', {
      clientId: 'client',
      hash: '',
      receipt: { requestId: 'd', status: 'done' },
    })
    restart(state)
    vi.advanceTimersByTime(10)
    expect([state.epoch, state.hostSeq, state.attention.length, state.timers.size]).toEqual([
      'epoch-2',
      0,
      0,
      0,
    ])
    expect([
      lane.seq,
      lane.events.length,
      lane.replayBytes,
      lane.pending.length,
      lane.messages.length,
    ]).toEqual([0, 0, 0, 0, 1])
    expect(state.receipts.get('p')).toEqual({
      clientId: 'client',
      hash: '',
      receipt: { requestId: 'p', status: 'unknown' },
      finishedAt: 1_000_000,
    })
    expect(state.receipts.get('d')?.finishedAt).toBeUndefined()
    expect([fired, closes, state.stopped]).toEqual([[], ['1001 Host restarting'], false])
  })

  it('revokes matching sessions and clients up to the revocation limit', () => {
    const state = host()
    const a = socket(state, 'one', 'alpha'),
      b = socket(state, 'two', 'beta')
    revokeSession(state, 'one')
    revokeClient(state, 'beta')
    expect([a, b]).toEqual([['4403 Revoked'], ['4403 Revoked']])
    for (let i = state.revokedSessions.size; i < GRANT_LIMITS.revocations; i++)
      revokeSession(state, `s${i}`)
    for (let i = state.revokedClients.size; i < GRANT_LIMITS.revocations; i++)
      revokeClient(state, `c${i}`)
    expect(() => revokeSession(state, 'more')).toThrow('Revocations full')
    expect(() => revokeClient(state, 'more')).toThrow('Revocations full')
    expect([state.revokedSessions.has('more'), state.revokedClients.has('more')]).toEqual([
      false,
      false,
    ])
  })

  it('stops by clearing timers and closing sockets, keeping stored state', () => {
    const state = host()
    addLane(state)
    const closes = socket(state, 'session', 'client')
    const fired: string[] = []
    state.timers.add(setTimeout(() => fired.push('timer'), 10))
    stop(state)
    vi.advanceTimersByTime(10)
    expect([state.stopped, state.timers.size, fired, closes, state.lanes.size]).toEqual([
      true,
      0,
      [],
      ['1001 Host stopping'],
      1,
    ])
  })
})
