import { utf8Length, type HostFrame } from '../../host-protocol'
import type { Connection, FakeHostState } from './state'
import { snapshot } from './streams'

export type SendOutcome = 'sent' | 'reset' | 'failed' | 'dropped'
/** The delivery callback stream helpers receive, so streams never import delivery at runtime. */
export type SendFrame = (state: FakeHostState, c: Connection, frame: HostFrame) => SendOutcome

/** The frame that replaces a subscription's missed stream: its current list or snapshot. */
export function catchUp(state: FakeHostState, c: Connection, id: string): HostFrame | null {
  const sub = c.subscriptions.get(id)
  if (!sub) return null
  if (sub.topic === 'lanes')
    return {
      type: 'lanes',
      id,
      cursor: { epoch: state.epoch, seq: state.hostSeq },
      repositories: state.repositories,
      lanes: [...state.lanes.values()].map((l) => l.summary),
    }
  const l = state.lanes.get(sub.laneId)
  return l
    ? { type: 'snapshot', id, laneId: sub.laneId, reset: true, snapshot: snapshot(state, l) }
    : null
}

/** One unref'd 50ms retry loop per connection resends stale subscriptions once it drains. */
export function recover(state: FakeHostState, c: Connection) {
  if (c.recoveryTimer !== undefined) return
  c.recoveryTimer = setTimeout(() => {
    c.recoveryTimer = undefined
    if (!c.socket.isOpen()) return
    if (c.socket.bufferedBytes() < state.limits.sendQueueBytes / 2) {
      for (const id of [...c.stale]) {
        c.stale.delete(id)
        const frame = catchUp(state, c, id)
        if (frame) send(state, c, frame)
      }
    }
    if (c.stale.size) recover(state, c)
  }, 50)
  c.recoveryTimer.unref?.()
}

/** Sends within the frame and queue limits: resets, fails or drops instead of exceeding them. */
export function send(state: FakeHostState, c: Connection, frame: HostFrame): SendOutcome {
  const limits = state.limits
  if (!c.socket.isOpen()) return 'dropped'
  let outcome: 'sent' | 'failed' = 'sent'
  const subId =
    'id' in frame && c.subscriptions.has(frame.id) && frame.type !== 'result' ? frame.id : null
  if (subId && c.stale.has(subId)) return 'dropped'
  let s = JSON.stringify(frame)
  if (
    utf8Length(s) > limits.outboundFrameBytes ||
    (subId && utf8Length(s) > limits.sendQueueBytes)
  ) {
    if (frame.type === 'event') {
      const replacement = catchUp(state, c, frame.id)
      if (!replacement) return 'dropped'
      const result = send(state, c, replacement)
      return result === 'sent' ? 'reset' : result
    }
    if (subId) {
      c.subscriptions.delete(subId)
      c.stale.delete(subId)
      frame = { type: 'subscribe-failed', id: subId, code: 'too-large' }
      outcome = 'failed'
    } else if (frame.type === 'result')
      frame = {
        type: 'result',
        id: frame.id,
        ok: false,
        error: { code: 'too-large', message: 'Result too large' },
      }
    else {
      c.socket.close(4429, 'Outbound limit')
      return 'failed'
    }
    s = JSON.stringify(frame)
  }
  if (c.socket.bufferedBytes() + utf8Length(s) > limits.sendQueueBytes) {
    if (subId && c.subscriptions.has(subId)) {
      c.stale.add(subId)
      recover(state, c)
    } else c.socket.close(4429, 'Slow client')
    return 'dropped'
  }
  c.socket.send(s)
  return outcome
}
