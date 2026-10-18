import { expect, it, vi } from 'vitest'
import type { HostFrame, LaneSummary, StreamCursor } from '@phosphor/shared/host-protocol'
import type { HostConnectionSnapshot } from '../connection'
import { handleLaneFrame, handleTerminalFrame, receiveFrame, type ReceiveContext } from './receive'
import { createSubscriptionState, type LaneFrame } from './subscriptions'

const laneA = '22222222-2222-4222-8222-222222222222'
const time = '2026-01-01T00:00:00.000Z'
const epochA = 'a'.repeat(16)
const epochB = 'b'.repeat(16)
const at = (seq: number, epoch = epochA): StreamCursor => ({ epoch, seq })
const summary = (title: string | null = null): LaneSummary => ({
  laneId: laneA,
  repositoryId: 'c'.repeat(16),
  cwd: '/fixture',
  title,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: time,
  updatedAt: time,
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
})

function context(cursor?: StreamCursor) {
  let view: HostConnectionSnapshot = {
    state: 'ready',
    connectionToken: 'token',
    capabilities: [],
    repositories: [],
    lanes: [summary()],
    cursor,
  }
  const ctx: ReceiveContext = {
    subscriptions: createSubscriptionState(),
    requests: { receipt: vi.fn(), result: vi.fn() },
    attention: [],
    ports: { onRoutinesChanged: vi.fn(), onAttention: vi.fn() },
    view: () => view,
    update: vi.fn((next: Partial<HostConnectionSnapshot>) => {
      view = { ...view, ...next }
    }),
    advanceCursor: vi.fn((next: StreamCursor) => {
      view = { ...view, cursor: next }
    }),
    subscribe: vi.fn(),
    close: vi.fn(),
    renewed: vi.fn(),
    pong: vi.fn(),
  }
  return ctx
}

it('dispatches session, receipt and result frames to their owners', () => {
  const ctx = context()
  const expiresAt = new Date(300_000).toISOString()
  receiveFrame(ctx, { type: 'auth-renewed', grantExpiresAt: expiresAt })
  receiveFrame(ctx, { type: 'pong', at: 1 })
  receiveFrame(ctx, { type: 'error', code: 4403, message: 'Late' })
  receiveFrame(ctx, { type: 'receipt', receipt: { requestId: 'r', status: 'pending' } })
  receiveFrame(ctx, { type: 'receipt', receipt: { requestId: 'r', status: 'done' } })
  const result: HostFrame = { type: 'result', id: 'c', ok: true, data: null }
  receiveFrame(ctx, result)
  expect(ctx.renewed).toHaveBeenCalledWith(expiresAt)
  expect(ctx.pong).toHaveBeenCalledTimes(1)
  expect(ctx.requests.receipt).toHaveBeenCalledTimes(1)
  expect(ctx.requests.receipt).toHaveBeenCalledWith({ requestId: 'r', status: 'done' })
  expect(ctx.requests.result).toHaveBeenCalledWith(result)
  expect(ctx.close).not.toHaveBeenCalled()
  expect(ctx.update).not.toHaveBeenCalled()
})

it('closes on a second ready frame', () => {
  const ctx = context()
  receiveFrame(ctx, {
    type: 'ready',
    protocolVersion: 1,
    hello: {
      hostId: laneA,
      hostVersion: '1.0.0',
      protocolVersion: 1,
      runtimeEpoch: epochA,
      capabilities: [],
    },
    proof: 'A'.repeat(86),
    connectionId: 'b'.repeat(16),
    grantExpiresAt: time,
    client: { id: laneA, label: 'Test' },
    capabilities: [],
  })
  expect(ctx.close).toHaveBeenCalledWith(4400, 'Duplicate ready')
})

it('ignores lanes-topic frames addressed to another subscription id', () => {
  const ctx = context(at(1))
  receiveFrame(ctx, { type: 'lanes', id: 'other', cursor: at(5), repositories: [], lanes: [] })
  receiveFrame(ctx, { type: 'routines-changed', id: 'other', cursor: at(2) })
  expect(ctx.update).not.toHaveBeenCalled()
  expect(ctx.advanceCursor).not.toHaveBeenCalled()
})

it.each([
  ['no cursor', undefined, at(1), 'ignored'],
  ['a foreign epoch', at(4), at(5, epochB), 'ignored'],
  ['a stale seq', at(4), at(4), 'ignored'],
  ['the next seq', at(4), at(5), 'applied'],
  ['a gap', at(4), at(7), 'resubscribed'],
] as const)('a lanes-delta after %s is %s', (_, cursor, next, outcome) => {
  const ctx = context(cursor)
  receiveFrame(ctx, { type: 'lanes-delta', id: 'lanes', cursor: next, upsert: [], remove: [laneA] })
  expect(ctx.view().lanes).toHaveLength(outcome === 'applied' ? 0 : 1)
  expect(ctx.view().cursor).toEqual(outcome === 'applied' ? next : cursor)
  expect(ctx.subscribe).toHaveBeenCalledTimes(outcome === 'resubscribed' ? 1 : 0)
  if (outcome === 'resubscribed') expect(ctx.subscribe).toHaveBeenCalledWith('lanes')
})

it.each([
  ['no cursor', undefined, at(1), 0, 0],
  ['a foreign epoch', at(4), at(5, epochB), 0, 0],
  ['a stale seq', at(4), at(4), 0, 0],
  ['the next seq', at(4), at(5), 1, 0],
  ['a gap', at(4), at(7), 1, 1],
] as const)('routines-changed after %s', (_, cursor, next, advanced, resubscribed) => {
  const ctx = context(cursor)
  receiveFrame(ctx, { type: 'routines-changed', id: 'lanes', cursor: next })
  expect(ctx.advanceCursor).toHaveBeenCalledTimes(advanced)
  expect(ctx.ports.onRoutinesChanged).toHaveBeenCalledTimes(advanced)
  expect(ctx.subscribe).toHaveBeenCalledTimes(resubscribed)
  expect(ctx.update).not.toHaveBeenCalled()
})

it('takes a new epoch from a lanes list and forgets attention from the old one', () => {
  const ctx = context(at(9))
  const frame = (seq: number, epoch = epochA): HostFrame => ({
    type: 'lanes',
    id: 'lanes',
    cursor: at(seq, epoch),
    repositories: [],
    lanes: [],
  })
  receiveFrame(ctx, {
    type: 'attention',
    id: 'lanes',
    cursor: at(10),
    event: { id: `${laneA}:1`, laneId: laneA, kind: 'failed', attention: 1, at: time, title: null },
  })
  receiveFrame(ctx, frame(3))
  expect(ctx.view().cursor).toEqual(at(10))
  expect(ctx.attention).toHaveLength(1)
  receiveFrame(ctx, frame(3, epochB))
  expect(ctx.view().cursor).toEqual(at(3, epochB))
  expect(ctx.attention).toHaveLength(0)
})

it('does not resurrect a cursor when an attention listener signed out', () => {
  const ctx = context(at(1))
  ctx.ports.onAttention = vi.fn(() => ctx.update({ cursor: undefined }))
  receiveFrame(ctx, {
    type: 'attention',
    id: 'lanes',
    cursor: at(2),
    event: { id: `${laneA}:1`, laneId: laneA, kind: 'failed', attention: 1, at: time, title: null },
  })
  expect(ctx.ports.onAttention).toHaveBeenCalledTimes(1)
  expect(ctx.update).toHaveBeenCalledTimes(1)
  expect(ctx.view().cursor).toBeUndefined()
})

it('routes terminal frames by subscription and terminal, and acks by sequence', () => {
  const ctx = context()
  const listener = vi.fn()
  const resolve = vi.fn()
  ctx.subscriptions.terminals.set('sub', { terminalId: 't1', listener })
  ctx.subscriptions.inputs.set('t1', { seq: 4, resolve })
  const output = {
    type: 'terminal.output',
    id: 'sub',
    terminalId: 't1',
    epoch: epochA,
    seq: 1,
    data: 'x',
  } as const
  receiveFrame(ctx, output)
  receiveFrame(ctx, { ...output, terminalId: 't2' })
  receiveFrame(ctx, { type: 'subscribe-failed', id: 'sub', code: 'forbidden' })
  receiveFrame(ctx, { type: 'terminal.ack', terminalId: 't1', seq: 3, accepted: true })
  expect(resolve).not.toHaveBeenCalled()
  handleTerminalFrame(ctx.subscriptions, {
    type: 'terminal.ack',
    terminalId: 't1',
    seq: 4,
    accepted: true,
  })
  expect(resolve).toHaveBeenCalledWith(true)
  expect(ctx.subscriptions.inputs.size).toBe(0)
  expect(listener.mock.calls.map(([f]) => f.type)).toEqual(['terminal.output', 'subscribe-failed'])
})

it('moves a lane cursor only in order and marks a snapshot from a new epoch as a reset', () => {
  const ctx = context()
  const frames: LaneFrame[] = []
  ctx.subscriptions.watches.set('w', { laneId: laneA, listener: (f) => frames.push(f) })
  const snapshot = (seq: number, epoch = epochA): LaneFrame => ({
    type: 'snapshot',
    id: 'w',
    laneId: laneA,
    reset: false,
    snapshot: {
      cursor: at(seq, epoch),
      summary: summary('Snap'),
      state: null,
      messages: [],
      pending: [],
      dialogs: [],
      ui: [],
    },
  })
  const event = (seq: number): LaneFrame => ({
    type: 'event',
    id: 'w',
    laneId: laneA,
    cursor: at(seq),
    event: { kind: 'summary', summary: summary(`Seq ${seq}`) },
  })
  handleLaneFrame(ctx, event(1))
  expect(ctx.subscribe).toHaveBeenLastCalledWith('w', laneA)
  handleLaneFrame(ctx, snapshot(4))
  handleLaneFrame(ctx, event(5))
  handleLaneFrame(ctx, event(7))
  expect(ctx.subscribe).toHaveBeenCalledTimes(2)
  expect(ctx.subscriptions.watches.get('w')?.cursor).toEqual(at(5))
  expect(ctx.view().lanes[0]?.title).toBe('Seq 5')
  handleLaneFrame(ctx, snapshot(1, epochB))
  expect(frames.map((f) => (f.type === 'snapshot' ? `reset:${f.reset}` : f.type))).toEqual([
    'reset:false',
    'event',
    'reset:true',
  ])
  handleLaneFrame(ctx, { type: 'subscribe-failed', id: 'lanes', code: 'too-many' })
  expect(ctx.view().lastError).toBe('too-many')
})
