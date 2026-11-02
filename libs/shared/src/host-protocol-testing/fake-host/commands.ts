import type { GrantPayload } from '../../host-grant'
import { send } from './delivery'
import { admitController, applyOperation, createLane } from './lane-operations'
import { deliver, prune, rejected, rejectStored } from './receipts'
import type { Command, Connection, FakeHostState, Lane, Stored } from './state'
import { turn } from './streams'

/**
 * Admits, applies and schedules one command frame. `mayControl` is the connection's effective
 * sessions.control capability (grant and Host); a refusal for it is stored like any other result.
 */
export function command(state: FakeHostState, c: Connection, f: Command, mayControl: boolean) {
  const grant = c.grant
  if (!grant) return
  const stored = admit(state, c, f, grant)
  if (!stored) return
  if (!mayControl) {
    rejectStored(state, stored, 'forbidden')
    return
  }
  if (f.op.type === 'lane.create') {
    const created = createLane(state, grant, f, f.op)
    if (typeof created !== 'string') {
      rejectStored(state, stored, created.code)
      return
    }
    // A first prompt runs as the new lane's first turn, as a prompt op would.
    const prompted = f.op.prompt === undefined ? undefined : state.lanes.get(created)
    if (prompted) turn(state, send, prompted)
    stored.receipt = {
      requestId: f.requestId,
      status: 'done',
      laneId: created,
      fence: 1,
      ...(prompted ? { data: { prompted: true } } : {}),
    }
    deliver(state, f.requestId, stored)
    return
  }
  const lane = f.laneId ? state.lanes.get(f.laneId) : undefined
  if (!lane) {
    rejectStored(state, stored, 'unknown-lane')
    return
  }
  const refusal = admitController(state, grant, f, lane) ?? applyOperation(state, grant, f.op, lane)
  if (refusal) {
    rejectStored(state, stored, refusal.code, refusal.lane)
    return
  }
  schedule(state, c, f, lane, stored)
}

/**
 * Deduplicates by request id before any cap, so a retry never costs a slot. Cap and conflict
 * refusals are unstored; an admitted command is stored as pending and wanted by its socket.
 */
export function admit(
  state: FakeHostState,
  c: Connection,
  f: Command,
  grant: GrantPayload,
): Stored | null {
  prune(state)
  const hash = JSON.stringify({ laneId: f.laneId, fence: f.fence, op: f.op })
  const old = state.receipts.get(f.requestId)
  if (old) {
    if (old.clientId !== grant.client.id || old.hash !== hash)
      rejected(state, c, f.requestId, 'conflict')
    else {
      send(state, c, { type: 'receipt', receipt: old.receipt })
      if (old.receipt.status === 'pending') c.wanted.add(f.requestId)
    }
    return null
  }
  if (c.pending >= state.limits.pendingCommandsPerConnection) {
    rejected(state, c, f.requestId, 'too-many-requests')
    return null
  }
  const started = [...state.receipts.values()].filter((r) => r.receipt.status === 'pending')
  if (started.length >= state.limits.receiptsKept) {
    rejected(state, c, f.requestId, 'busy')
    return null
  }
  const stored: Stored = {
    clientId: grant.client.id,
    hash,
    receipt: { requestId: f.requestId, status: 'pending' },
  }
  state.receipts.set(f.requestId, stored)
  c.wanted.add(f.requestId)
  return stored
}

/**
 * Completion races the uncertainty deadline; the first to fire in this epoch settles the
 * receipt and cancels the other. A restart clears both and leaves the receipt unknown.
 */
function schedule(state: FakeHostState, c: Connection, f: Command, l: Lane, stored: Stored) {
  c.pending++
  state.executions++
  const startingEpoch = state.epoch
  const timer = setTimeout(() => {
    state.timers.delete(timer)
    if (state.epoch !== startingEpoch || stored.receipt.status !== 'pending') return
    clearTimeout(deadline)
    state.timers.delete(deadline)
    c.pending--
    if (l.summary.activity === 'failed') {
      stored.receipt = { requestId: f.requestId, status: 'unknown' }
      deliver(state, f.requestId, stored)
      return
    }
    if (f.op.type === 'prompt') turn(state, send, l)
    stored.receipt = { requestId: f.requestId, status: 'done', fence: l.summary.control.fence }
    deliver(state, f.requestId, stored)
  }, state.options.commandDelayMs ?? 1)
  const deadline = setTimeout(() => {
    state.timers.delete(deadline)
    if (state.epoch !== startingEpoch || stored.receipt.status !== 'pending') return
    clearTimeout(timer)
    state.timers.delete(timer)
    c.pending--
    stored.receipt = { requestId: f.requestId, status: 'unknown' }
    deliver(state, f.requestId, stored)
  }, state.limits.commandAnswerMs)
  state.timers.add(timer)
  state.timers.add(deadline)
}
