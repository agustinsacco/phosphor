import {
  parseClientFrame,
  utf8Length,
  type ClientFrame,
  type FrameSocket,
} from '../../host-protocol'
import { authenticate, authorized } from './auth'
import { call } from './calls'
import { command } from './commands'
import { send } from './delivery'
import { prune, rejected } from './receipts'
import type { Connection, FakeHostState } from './state'
import { publish, summary } from './streams'
import { subscribe, unsubscribe } from './subscriptions'

/** Accepts a socket unless stopping or at the unauthenticated flood cap; auth must follow. */
export function attach(state: FakeHostState, socket: FrameSocket) {
  const limits = state.limits
  if (state.stopped) {
    socket.close(1001, 'Host stopping')
    return
  }
  // An unauthenticated flood cannot allocate an unbounded timer/connection set.
  if (state.connections.size >= limits.connectionsPerClient * limits.lanesPerHost) {
    socket.close(4429, 'Too many connections')
    return
  }
  const c: Connection = {
    socket,
    grant: null,
    subscriptions: new Map(),
    wanted: new Set(),
    delivered: new Set(),
    pending: 0,
    calls: 0,
    stale: new Set(),
    authTimer: setTimeout(() => socket.close(4401, 'Auth timeout'), limits.authTimeoutMs),
  }
  state.connections.add(c)
  socket.onMessage((s) => receive(state, c, s))
  socket.onClose(() => disconnect(state, c))
}

/** Every inbound text re-arms idle; a refused frame is answered by its reply kind or closes. */
export function receive(state: FakeHostState, c: Connection, s: string) {
  const limits = state.limits,
    socket = c.socket
  clearTimeout(c.idleTimer)
  c.idleTimer = setTimeout(() => socket.close(4401, 'Idle'), limits.idleCloseMs)
  if (utf8Length(s) > limits.inboundFrameBytes) {
    socket.close(4400, 'Frame too large')
    return
  }
  const p = parseClientFrame(s)
  if (p.ok) dispatch(state, c, p.frame)
  else if (!c.grant) socket.close(4401, 'Auth required')
  else if (p.reply?.kind === 'receipt') rejected(state, c, p.reply.requestId, p.reply.code)
  else if (p.reply?.kind === 'result')
    send(state, c, {
      type: 'result',
      id: p.reply.id,
      ok: false,
      error: { code: p.reply.code, message: p.reply.code },
    })
  else socket.close(4400, 'Bad frame')
}

/** Auth first; afterwards each frame type goes to its module. Unmodelled frames are ignored. */
export function dispatch(state: FakeHostState, c: Connection, f: ClientFrame) {
  if (f.type === 'auth') authenticate(state, c, f)
  else if (!c.grant) c.socket.close(4401, 'Auth required')
  else if (f.type === 'ping') send(state, c, { type: 'pong', at: f.at })
  else if (f.type === 'unsubscribe') unsubscribe(c, f.id)
  else if (f.type === 'command') command(state, c, f, authorized(state, c, 'sessions.control'))
  else if (f.type === 'receipt-status') receiptStatus(state, c, f.requestId)
  else if (f.type === 'subscribe') subscribe(state, c, f)
  else if (f.type === 'call') call(state, c, f)
}

/** Another client's request reads as unknown; a pending lookup adds this socket's interest. */
export function receiptStatus(state: FakeHostState, c: Connection, requestId: string) {
  prune(state)
  const r = state.receipts.get(requestId)
  if (!r || r.clientId !== c.grant?.client.id)
    send(state, c, { type: 'receipt', receipt: { requestId, status: 'unknown' } })
  else {
    send(state, c, { type: 'receipt', receipt: r.receipt })
    if (r.receipt.status === 'pending') c.wanted.add(requestId)
  }
}

/** Clears the socket's timers; a controller is away only once its client has no socket left. */
export function disconnect(state: FakeHostState, c: Connection) {
  state.connections.delete(c)
  clearTimeout(c.authTimer)
  clearTimeout(c.expiryTimer)
  clearTimeout(c.idleTimer)
  clearTimeout(c.recoveryTimer)
  for (const l of state.lanes.values())
    if (
      l.summary.control.controller &&
      l.summary.control.controller.clientId === c.grant?.client.id &&
      ![...state.connections].some((other) => other.grant?.client.id === c.grant?.client.id)
    ) {
      l.summary = {
        ...l.summary,
        control: {
          ...l.summary.control,
          controller: { ...l.summary.control.controller, connected: false },
        },
      }
      publish(state, send, l, { kind: 'control', control: l.summary.control })
      summary(state, send, l)
    }
}
