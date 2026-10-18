import type { TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import { HOST_LIMITS, type HostFrame, type StreamCursor } from '@phosphor/shared/host-protocol'
import type { HostConnectionSnapshot } from '../connection'
import type { createRequests } from '../requests'
import { ackInput, type LaneFrame, type SubscriptionState } from './subscriptions'

type Frame<T extends HostFrame['type']> = Extract<HostFrame, { type: T }>
export type AttentionFrame = Frame<'attention'>
type DirectoryFrame = Frame<'lanes' | 'routines-changed' | 'lanes-delta' | 'attention'>

const ATTENTION_KEPT = 50

/** What routing an authenticated frame reads and changes. The connection owns all of it. */
export interface ReceiveContext {
  readonly subscriptions: SubscriptionState
  readonly requests: Pick<ReturnType<typeof createRequests>, 'receipt' | 'result'>
  /** Attention in the current cursor epoch, ordered by seq. */
  readonly attention: AttentionFrame[]
  readonly ports: {
    onRoutinesChanged?: () => void
    onAttention?: (event: AttentionFrame['event']) => void
  }
  view(): HostConnectionSnapshot
  /** Changes the view and publishes it. */
  update(next: Partial<HostConnectionSnapshot>): void
  /** Moves the cursor without publishing: only the routines surface changed. */
  advanceCursor(cursor: StreamCursor): void
  subscribe(id: string, laneId?: string, after?: StreamCursor): void
  close(code: number, reason: string): void
  renewed(grantExpiresAt: string): void
  pong(): void
}

/** Routes one frame received after ready. An `error` frame waits for its close code. */
export function receiveFrame(ctx: ReceiveContext, f: HostFrame): void {
  switch (f.type) {
    case 'ready':
      ctx.close(4400, 'Duplicate ready')
      return
    case 'auth-renewed':
      ctx.renewed(f.grantExpiresAt)
      return
    case 'pong':
      ctx.pong()
      return
    case 'lanes':
    case 'routines-changed':
    case 'lanes-delta':
    case 'attention':
      if (f.id === 'lanes') handleDirectoryFrame(ctx, f)
      return
    case 'terminal.ack':
    case 'terminal.reset':
    case 'terminal.output':
    case 'terminal.exit':
      handleTerminalFrame(ctx.subscriptions, f)
      return
    case 'subscribe-failed':
      if (ctx.subscriptions.terminals.has(f.id)) handleTerminalFrame(ctx.subscriptions, f)
      else handleLaneFrame(ctx, f)
      return
    case 'snapshot':
    case 'event':
      handleLaneFrame(ctx, f)
      return
    case 'receipt':
      if (f.receipt.status !== 'pending') ctx.requests.receipt(f.receipt)
      return
    case 'result':
      ctx.requests.result(f)
  }
}

/** The lanes topic. Every frame but `lanes` itself needs a cursor in the same epoch. */
export function handleDirectoryFrame(ctx: ReceiveContext, f: DirectoryFrame): void {
  if (f.type === 'lanes') applyLanes(ctx, f)
  else if (f.type === 'routines-changed') applyRoutinesChanged(ctx, f)
  else {
    const cursor = ctx.view().cursor
    if (!cursor || cursor.epoch !== f.cursor.epoch) return
    if (f.type === 'attention') applyAttention(ctx, f)
    else applyLanesDelta(ctx, f, cursor)
  }
}

/** A list keeps the highest seq of its epoch; a new epoch forgets the old attention. */
function applyLanes(ctx: ReceiveContext, f: Frame<'lanes'>): void {
  const cursor = ctx.view().cursor
  if (cursor?.epoch !== f.cursor.epoch) ctx.attention.length = 0
  ctx.update({
    repositories: [...f.repositories],
    lanes: [...f.lanes],
    cursor: {
      epoch: f.cursor.epoch,
      seq: cursor?.epoch === f.cursor.epoch ? Math.max(cursor.seq, f.cursor.seq) : f.cursor.seq,
    },
  })
}

function applyRoutinesChanged(ctx: ReceiveContext, f: Frame<'routines-changed'>): void {
  const cursor = ctx.view().cursor
  if (!cursor || cursor.epoch !== f.cursor.epoch || f.cursor.seq <= cursor.seq) return
  if (f.cursor.seq !== cursor.seq + 1) ctx.subscribe('lanes')
  // Only the routines surface changed; do not invalidate every Host query.
  ctx.advanceCursor(f.cursor)
  ctx.ports.onRoutinesChanged?.()
}

/** Attention is deduplicated by event id, kept in seq order and bounded; gaps are fine. */
function applyAttention(ctx: ReceiveContext, f: AttentionFrame): void {
  if (!ctx.attention.some((a) => a.event.id === f.event.id)) {
    ctx.attention.push(f)
    ctx.ports.onAttention?.(f.event)
  }
  ctx.attention.sort((a, b) => a.cursor.seq - b.cursor.seq)
  if (ctx.attention.length > ATTENTION_KEPT) ctx.attention.shift()
  // Read after the listener, which may have signed out and dropped the cursor.
  const cursor = ctx.view().cursor
  if (cursor)
    ctx.update({ cursor: { epoch: f.cursor.epoch, seq: Math.max(cursor.seq, f.cursor.seq) } })
}

/** Deltas apply strictly in order; a gap asks for the whole list again. */
function applyLanesDelta(ctx: ReceiveContext, f: Frame<'lanes-delta'>, cursor: StreamCursor): void {
  if (f.cursor.seq <= cursor.seq) return
  if (f.cursor.seq !== cursor.seq + 1) {
    ctx.subscribe('lanes')
    return
  }
  const lanes = new Map(ctx.view().lanes.map((l) => [l.laneId, l]))
  for (const id of f.remove) lanes.delete(id)
  for (const l of f.upsert) lanes.set(l.laneId, l)
  if (lanes.size > HOST_LIMITS.lanesPerHost) {
    ctx.close(4400, 'Lane limit')
    return
  }
  ctx.update({ lanes: [...lanes.values()], cursor: f.cursor })
}

/** Terminal frames reach only the watch that subscribed to that terminal. */
export function handleTerminalFrame(
  state: SubscriptionState,
  f: TerminalFrame | Frame<'subscribe-failed'>,
): void {
  if (f.type === 'terminal.ack') ackInput(state, f)
  else if (f.type === 'subscribe-failed') state.terminals.get(f.id)?.listener(f)
  else {
    const w = state.terminals.get(f.id)
    if (w?.terminalId === f.terminalId) w.listener(f)
  }
}

/** A lane stream continues from its cursor; a gap or new epoch resubscribes from a snapshot. */
export function handleLaneFrame(ctx: ReceiveContext, f: LaneFrame): void {
  const w = ctx.subscriptions.watches.get(f.id)
  if (!w || (f.type !== 'subscribe-failed' && f.laneId !== w.laneId)) {
    if (f.type === 'subscribe-failed' && f.id === 'lanes') ctx.update({ lastError: f.code })
    return
  }
  if (f.type === 'subscribe-failed') {
    w.listener(f)
    return
  }
  if (
    f.type === 'event' &&
    (!w.cursor || w.cursor.epoch !== f.cursor.epoch || f.cursor.seq !== w.cursor.seq + 1)
  ) {
    ctx.subscribe(f.id, w.laneId)
    return
  }
  const reset =
    f.type === 'snapshot' && (f.reset || (!!w.cursor && w.cursor.epoch !== f.snapshot.cursor.epoch))
  w.cursor = f.type === 'snapshot' ? f.snapshot.cursor : f.cursor
  foldLaneSummary(ctx, f)
  w.listener(f.type === 'snapshot' ? { ...f, reset } : f)
}

/** Snapshots, summary and control events also change the lane's row in the list. */
function foldLaneSummary(ctx: ReceiveContext, f: Frame<'snapshot' | 'event'>): void {
  const lanes = ctx.view().lanes
  if (f.type === 'snapshot') {
    ctx.update({ lanes: lanes.map((l) => (l.laneId === f.laneId ? f.snapshot.summary : l)) })
    return
  }
  const event = f.event
  if (event.kind !== 'control' && event.kind !== 'summary') return
  ctx.update({
    lanes: lanes.map((l) =>
      l.laneId !== f.laneId
        ? l
        : event.kind === 'summary'
          ? event.summary
          : { ...l, control: event.control },
    ),
  })
}
