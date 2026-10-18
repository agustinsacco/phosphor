import { isUuid } from '../../control-api'
import { HOST_CALL_METHODS, type ClientFrame, type HostFrame } from '../../host-protocol'
import { authorized } from './auth'
import { send } from './delivery'
import type { Connection, FakeHostState, Lane } from './state'
import { snapshot } from './streams'

type Call = Extract<ClientFrame, { type: 'call' }>
type CallErrorCode = Extract<HostFrame, { type: 'result'; ok: false }>['error']['code']

/**
 * Read calls. host.repositories answers at once; lane reads are capped per socket and answer on
 * the next tick, only while the socket is open and still holds read authority.
 */
export function call(state: FakeHostState, c: Connection, f: Call) {
  const error = (code: CallErrorCode) =>
    send(state, c, { type: 'result', id: f.id, ok: false, error: { code, message: code } })
  if (!authorized(state, c, 'sessions.read')) error('forbidden')
  else if (!HOST_CALL_METHODS.some((m) => m === f.method)) error('unsupported')
  else if (f.method === 'host.repositories')
    send(state, c, { type: 'result', id: f.id, ok: true, data: state.repositories })
  else if (c.calls >= state.limits.pendingCommandsPerConnection)
    c.socket.close(4429, 'Too many calls')
  else {
    const laneId = paramsLane(f.params)
    const l = laneId ? state.lanes.get(laneId) : undefined
    if (!laneId) error('bad-request')
    else if (!l) error('unknown-lane')
    else answerLater(state, c, f.id, laneRead(state, f.method, laneId, l))
  }
}

/** The read's data, built now; lane.messages shares the lane's transcript array. */
export function laneRead(state: FakeHostState, method: string, laneId: string, l: Lane): unknown {
  return method === 'lane.messages'
    ? { messages: l.messages }
    : method === 'lane.state'
      ? snapshot(state, l).state
      : method === 'lane.models'
        ? { models: [] }
        : method === 'lane.commands'
          ? { commands: [] }
          : {
              sessionId: laneId,
              userMessages: 0,
              assistantMessages: l.messages.length,
              toolCalls: 0,
              toolResults: 0,
              totalMessages: l.messages.length,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: 0,
            }
}

function answerLater(state: FakeHostState, c: Connection, id: string, data: unknown) {
  c.calls++
  const timer = setTimeout(() => {
    state.timers.delete(timer)
    c.calls--
    if (c.socket.isOpen() && authorized(state, c, 'sessions.read'))
      send(state, c, { type: 'result', id, ok: true, data })
  }, 0)
  state.timers.add(timer)
}

export function paramsLane(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || !('laneId' in v)) return null
  return isUuid(v.laneId) ? v.laneId : null
}
