import { GRANT_LIMITS } from '../../host-grant'
import { HOST_LIMITS, utf8Length } from '../../host-protocol'
import type { ExtensionUIRequest } from '../../rpc'
import { send } from './delivery'
import type { FakeHostState, Lane } from './state'
import { notify, publish, turn } from './streams'

/** Where a stateful UI request is kept: its key, its kind's prefix and whether it clears. */
interface UiSlot {
  prefix: 'status:' | 'widget:' | 'title:'
  key: string
  clear: boolean
}

export function laneOf(state: FakeHostState, id: string): Lane {
  const l = state.lanes.get(id)
  if (!l) throw new Error('Unknown lane')
  return l
}

export function emitTurn(state: FakeHostState, id: string) {
  return turn(state, send, laneOf(state, id))
}

/** Streams any UI request; setStatus, setWidget and setTitle also replace the lane's latest one. */
export function emitUi(state: FakeHostState, id: string, request: ExtensionUIRequest) {
  const l = laneOf(state, id)
  const slot = uiSlot(request)
  if (slot) storeUi(state, l, slot, request)
  publish(state, send, l, { kind: 'pi', push: { kind: 'extension-ui', request } })
}

/** Only status, widget and title requests are state; a missing text or empty widget clears. */
export function uiSlot(request: ExtensionUIRequest): UiSlot | null {
  if (request.method === 'setStatus')
    return {
      prefix: 'status:',
      key: 'status:' + request.statusKey,
      clear: request.statusText === undefined,
    }
  if (request.method === 'setWidget')
    return {
      prefix: 'widget:',
      key: 'widget:' + request.widgetKey,
      clear: !request.widgetLines?.length,
    }
  if (request.method === 'setTitle') return { prefix: 'title:', key: 'title:', clear: false }
  return null
}

/** How many keys of a kind a lane may hold; the title is a single key. */
export function uiBound(state: FakeHostState, prefix: UiSlot['prefix']): number {
  return prefix === 'status:'
    ? state.limits.uiStatusKeys
    : prefix === 'widget:'
      ? state.limits.uiWidgetKeys
      : 1
}

/** Clears, replaces in place, or adds a key while its kind has room and the request fits a frame. */
function storeUi(state: FakeHostState, l: Lane, slot: UiSlot, request: ExtensionUIRequest) {
  if (slot.clear) {
    l.ui.delete(slot.key)
    return
  }
  if (
    !l.ui.has(slot.key) &&
    [...l.ui.keys()].filter((k) => k.startsWith(slot.prefix)).length >= uiBound(state, slot.prefix)
  )
    throw new Error('UI keys full')
  if (utf8Length(JSON.stringify(request)) > HOST_LIMITS.outboundFrameBytes)
    throw new Error('UI request too large')
  l.ui.set(slot.key, request)
}

export function openDialog(state: FakeHostState, id: string, dialogId: string) {
  const l = laneOf(state, id)
  if (l.dialogs.length >= state.limits.pendingEvents) throw new Error('Too many dialogs')
  const d: ExtensionUIRequest = {
    type: 'extension_ui_request',
    id: dialogId,
    method: 'confirm',
    title: 'Continue?',
    message: 'Scripted question',
  }
  l.dialogs.push(d)
  l.summary = { ...l.summary, activity: 'needs-input' }
  publish(state, send, l, { kind: 'pi', push: { kind: 'extension-ui', request: d } })
  notify(state, send, l, 'needs-input')
}

export function failLane(state: FakeHostState, id: string) {
  const l = laneOf(state, id)
  l.summary = { ...l.summary, activity: 'failed' }
  publish(state, send, l, {
    kind: 'pi',
    push: { kind: 'exit', code: 1, signal: null, expected: false },
  })
  notify(state, send, l, 'failed')
}

/** A new epoch: timers and replay are gone, pending receipts become unknown, sockets close. */
export function restart(state: FakeHostState) {
  state.epoch = state.options.epoch()
  state.hostSeq = 0
  state.attention.length = 0
  clearTimers(state)
  for (const r of state.receipts.values())
    if (r.receipt.status === 'pending') {
      r.receipt = { requestId: r.receipt.requestId, status: 'unknown' }
      r.finishedAt = Date.now()
    }
  for (const l of state.lanes.values()) {
    l.seq = 0
    l.events.length = 0
    l.replayBytes = 0
    l.pending.length = 0
  }
  for (const c of state.connections) c.socket.close(1001, 'Host restarting')
}

export function revokeSession(state: FakeHostState, id: string) {
  if (state.revokedSessions.size >= GRANT_LIMITS.revocations) throw new Error('Revocations full')
  state.revokedSessions.add(id)
  for (const c of state.connections) if (c.grant?.sid === id) c.socket.close(4403, 'Revoked')
}

export function revokeClient(state: FakeHostState, id: string) {
  if (state.revokedClients.size >= GRANT_LIMITS.revocations) throw new Error('Revocations full')
  state.revokedClients.add(id)
  for (const c of state.connections) if (c.grant?.client.id === id) c.socket.close(4403, 'Revoked')
}

export function stop(state: FakeHostState) {
  state.stopped = true
  clearTimers(state)
  for (const c of state.connections) c.socket.close(1001, 'Host stopping')
}

function clearTimers(state: FakeHostState) {
  for (const timer of state.timers) clearTimeout(timer)
  state.timers.clear()
}
