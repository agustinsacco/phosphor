import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GrantClient, GrantPayload } from '../../host-grant'
import type { FrameSocket, HostFrame, LaneOp } from '../../host-protocol'
import type { ExtensionUIRequest } from '../../rpc'
import { admitController, applyOperation, createLane, thinkingLevel } from './lane-operations'
import {
  createFakeHostState,
  type Command,
  type FakeHostState,
  type Lane,
  type Limits,
} from './state'

const FIRST: GrantClient = { id: '00000000-0000-4000-8000-0000000000c1', label: 'First' }
const SECOND: GrantClient = { id: '00000000-0000-4000-8000-0000000000c2', label: 'Second' }
const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/repository' }

function host(limits: Partial<Limits> = {}) {
  const ids: string[] = []
  const state = createFakeHostState({
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => {
      ids.push(`id-${ids.length + 1}`)
      return ids[ids.length - 1] ?? ''
    },
    epoch: () => 'epoch',
    repositories: [REPOSITORY],
    limits,
  })
  return { state, ids }
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
/** Subscribes a recording socket to the lane and the lanes list; returns the frame log. */
function watch(state: FakeHostState, laneId: string) {
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
  state.connections.add({
    socket,
    grant: null,
    subscriptions: new Map([
      ['lane', { type: 'subscribe', id: 'lane', topic: 'lane', laneId }],
      ['all', { type: 'subscribe', id: 'all', topic: 'lanes' }],
    ]),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer,
  })
  return () =>
    frames.map((f) =>
      f.type === 'event'
        ? `${f.event.kind}${f.event.kind === 'control' ? `:f${f.event.control.fence}:${f.event.control.controller?.label ?? '-'}` : ''}${f.event.kind === 'summary' ? `:${f.event.summary.activity}` : ''}`
        : f.type,
    )
}
const create = (extra: Partial<Extract<LaneOp, { type: 'lane.create' }>> = {}) => ({
  type: 'lane.create' as const,
  repositoryId: REPOSITORY.id,
  worktree: null,
  ...extra,
})
const commandFor = (op: LaneOp, fence?: number, laneId?: string): Command => ({
  type: 'command',
  requestId: '00000000-0000-4000-9000-000000000001',
  op,
  ...(laneId === undefined ? {} : { laneId }),
  ...(fence === undefined ? {} : { fence }),
})
function laneOf(state: FakeHostState): Lane {
  const created = createLane(state, grant(FIRST), commandFor(create()), create())
  const lane = typeof created === 'string' ? state.lanes.get(created) : undefined
  if (!lane) throw new Error('No lane')
  return lane
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createLane', () => {
  it('creates an idle lane controlled by its creator, announcing it with ids in order', () => {
    const { state, ids } = host()
    const frames = watch(state, 'id-1')
    const op = create({
      name: 'Lane',
      worktree: { branch: 'feature' },
      provider: 'p',
      model: 'm',
      thinkingLevel: 'high',
    })
    expect(createLane(state, grant(FIRST), commandFor(op), op)).toBe('id-1')
    expect(ids).toEqual(['id-1', 'id-2'])
    expect(state.lanes.get('id-1')).toMatchObject({
      sessionId: 'id-2',
      thinkingLevel: 'high',
      summary: {
        cwd: '/repository',
        title: 'Lane',
        branch: 'feature',
        worktree: true,
        model: { provider: 'p', id: 'm' },
        activity: 'idle',
        createdAt: '2026-01-01T00:00:00.000Z',
        control: { fence: 1, controller: { clientId: FIRST.id, label: 'First', connected: true } },
      },
    })
    expect([frames(), state.hostSeq]).toEqual([['lanes-delta'], 1])
  })

  it('defaults the title, branch, model and thinking level', () => {
    const { state } = host()
    const lane = laneOf(state)
    expect(lane.summary).toMatchObject({ title: null, branch: null, worktree: false, model: null })
    expect(lane.thinkingLevel).toBe('off')
    const partial = create({ provider: 'p' })
    createLane(state, grant(FIRST), commandFor(partial), partial)
    expect(state.lanes.get('id-3')?.summary.model).toBeNull()
  })

  it('refuses a lane id, an unknown repository or a full Host without consuming ids', () => {
    const { state, ids } = host({ lanesPerHost: 1 })
    const op = create()
    expect(createLane(state, grant(FIRST), commandFor(op, undefined, 'lane'), op)).toEqual({
      code: 'bad-request',
    })
    const unknown = create({ repositoryId: 'fedcba9876543210' })
    expect(createLane(state, grant(FIRST), commandFor(unknown), unknown)).toEqual({
      code: 'bad-request',
    })
    laneOf(state)
    expect(createLane(state, grant(FIRST), commandFor(op), op)).toEqual({
      code: 'too-many-requests',
    })
    expect(ids).toEqual(['id-1', 'id-2'])
  })

  it('accepts only pi thinking levels', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      expect(thinkingLevel(level)).toBe(level)
    expect(() => thinkingLevel('extreme')).toThrow('Invalid thinking level')
  })
})

describe('admitController', () => {
  it('fences by number and controller, but never take or markRead', () => {
    const { state } = host()
    const lane = laneOf(state)
    const second = grant(SECOND)
    for (const op of [{ type: 'control.take' }, { type: 'lane.markRead', upTo: 1 }] as const)
      expect(admitController(state, second, commandFor(op, 9), lane)).toBeNull()
    expect(admitController(state, grant(FIRST), commandFor({ type: 'abort' }), lane)).toEqual({
      code: 'stale-fence',
      lane,
    })
    expect(admitController(state, second, commandFor({ type: 'abort' }, 1), lane)).toEqual({
      code: 'not-controller',
      lane,
    })
    expect(admitController(state, grant(FIRST), commandFor({ type: 'abort' }, 1), lane)).toBeNull()
  })

  it('refuses releasing an uncontrolled lane and claims it for any other op', () => {
    const { state } = host()
    const lane = laneOf(state)
    lane.summary = { ...lane.summary, control: { fence: 2, controller: null } }
    const frames = watch(state, lane.summary.laneId)
    const release = commandFor({ type: 'control.release' }, 2)
    expect(admitController(state, grant(SECOND), release, lane)).toEqual({
      code: 'not-controller',
      lane,
    })
    expect(admitController(state, grant(SECOND), commandFor({ type: 'abort' }, 2), lane)).toBeNull()
    expect(lane.summary.control).toEqual({
      fence: 3,
      controller: { clientId: SECOND.id, label: 'Second', connected: true },
    })
    expect(frames()).toEqual(['control:f3:Second', 'summary:idle', 'lanes-delta'])
  })
})

describe('applyOperation', () => {
  it('takes and releases control, each with a new fence', () => {
    const { state } = host()
    const lane = laneOf(state)
    const frames = watch(state, lane.summary.laneId)
    expect(applyOperation(state, grant(SECOND), { type: 'control.take' }, lane)).toBeNull()
    expect(applyOperation(state, grant(SECOND), { type: 'control.release' }, lane)).toBeNull()
    expect(frames().filter((f) => f.startsWith('control'))).toEqual([
      'control:f2:Second',
      'control:f3:-',
    ])
  })

  it('marks attention read without exceeding it or moving backwards', () => {
    const { state } = host()
    const lane = laneOf(state)
    lane.summary = { ...lane.summary, attention: 3, read: 2 }
    const read = (upTo: number) => {
      applyOperation(state, grant(SECOND), { type: 'lane.markRead', upTo }, lane)
      return lane.summary.read
    }
    expect([read(1), read(9), read(0)]).toEqual([2, 3, 3])
  })

  it('stops and resumes, refusing every other op while stopped or failed', () => {
    const { state } = host()
    const lane = laneOf(state)
    const first = grant(FIRST)
    applyOperation(state, first, { type: 'lane.stop' }, lane)
    expect(lane.summary.activity).toBe('stopped')
    for (const op of [
      { type: 'prompt', message: 'Hi' },
      { type: 'set_session_name', name: 'Name' },
      { type: 'abort' },
    ] as const)
      expect(applyOperation(state, first, op, lane)).toEqual({ code: 'lane-stopped' })
    expect(applyOperation(state, first, { type: 'lane.resume' }, lane)).toBeNull()
    expect(lane.summary.activity).toBe('idle')
    lane.summary = { ...lane.summary, activity: 'failed' }
    expect(applyOperation(state, first, { type: 'abort' }, lane)).toEqual({ code: 'lane-stopped' })
  })

  it('resolves only open dialogs, publishing the resolution before the summary', () => {
    const { state } = host()
    const lane = laneOf(state)
    const dialog = (id: string): ExtensionUIRequest => ({
      type: 'extension_ui_request',
      id,
      method: 'confirm',
      title: 'Continue?',
      message: 'Question',
    })
    lane.dialogs.push(dialog('one'), dialog('two'))
    lane.summary = { ...lane.summary, activity: 'needs-input' }
    const frames = watch(state, lane.summary.laneId)
    const answer = (id: string): LaneOp => ({
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id, confirmed: true },
    })
    expect(applyOperation(state, grant(FIRST), answer('missing'), lane)).toEqual({
      code: 'bad-request',
    })
    expect(applyOperation(state, grant(FIRST), answer('one'), lane)).toBeNull()
    expect(applyOperation(state, grant(FIRST), answer('two'), lane)).toBeNull()
    expect(frames()).toEqual([
      'dialog-resolved',
      'summary:needs-input',
      'lanes-delta',
      'dialog-resolved',
      'summary:idle',
      'lanes-delta',
    ])
  })

  it('renames, sets the model and thinking level, and leaves pi-only ops untouched', () => {
    const { state } = host()
    const lane = laneOf(state)
    const frames = watch(state, lane.summary.laneId)
    const first = grant(FIRST)
    applyOperation(state, first, { type: 'set_session_name', name: 'Renamed' }, lane)
    applyOperation(state, first, { type: 'set_model', provider: 'p', modelId: 'm' }, lane)
    applyOperation(state, first, { type: 'set_thinking_level', level: 'low' }, lane)
    applyOperation(state, first, { type: 'prompt', message: 'Hi' }, lane)
    expect(lane.summary).toMatchObject({ title: 'Renamed', model: { provider: 'p', id: 'm' } })
    expect(lane.thinkingLevel).toBe('low')
    expect(frames()).toEqual(['summary:idle', 'lanes-delta', 'summary:idle', 'lanes-delta'])
  })
})
