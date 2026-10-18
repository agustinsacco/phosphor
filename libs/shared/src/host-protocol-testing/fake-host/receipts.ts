import type { RejectCode } from '../../host-protocol'
import { send } from './delivery'
import type { Connection, FakeHostState, Lane, Stored } from './state'

/** Drops a stored receipt and every connection's interest in it. */
export function forget(state: FakeHostState, id: string) {
  state.receipts.delete(id)
  for (const c of state.connections) {
    c.wanted.delete(id)
    c.delivered.delete(id)
  }
}

/** Expires finished receipts by age, then keeps only the newest `receiptsKept` finished ones. */
export function prune(state: FakeHostState) {
  const limits = state.limits
  for (const [id, r] of state.receipts)
    if (r.finishedAt !== undefined && Date.now() - r.finishedAt > limits.receiptTtlMs)
      forget(state, id)
  const finished = [...state.receipts].filter(([, r]) => r.receipt.status !== 'pending')
  for (const [id] of finished.slice(0, Math.max(0, finished.length - limits.receiptsKept)))
    forget(state, id)
}

/** Sends a receipt to the owning client's interested sockets; a terminal one reaches each once. */
export function deliver(state: FakeHostState, requestId: string, stored: Stored) {
  if (stored.receipt.status !== 'pending') {
    stored.finishedAt ??= Date.now()
    prune(state)
  }
  for (const c of state.connections)
    if (
      c.grant?.client.id === stored.clientId &&
      c.wanted.has(requestId) &&
      !c.delivered.has(requestId)
    ) {
      send(state, c, { type: 'receipt', receipt: stored.receipt })
      if (stored.receipt.status !== 'pending') {
        c.delivered.add(requestId)
        c.wanted.delete(requestId)
      }
    }
}

/** An unstored refusal, answered to the asking socket only. */
export function rejected(
  state: FakeHostState,
  c: Connection,
  requestId: string,
  code: RejectCode,
  lane?: Lane,
) {
  send(state, c, {
    type: 'receipt',
    receipt: {
      requestId,
      status: 'rejected',
      code,
      ...(lane ? { control: lane.summary.control } : {}),
    },
  })
}

/** Settles an admitted command as refused and delivers it like any terminal receipt. */
export function rejectStored(state: FakeHostState, stored: Stored, code: RejectCode, lane?: Lane) {
  const requestId = stored.receipt.requestId
  stored.receipt = {
    requestId,
    status: 'rejected',
    code,
    ...(lane ? { control: lane.summary.control } : {}),
  }
  deliver(state, requestId, stored)
}
