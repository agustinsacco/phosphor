import type { HostFrame } from '@phosphor/shared/host-protocol'
import { clearIdleTimer, fail, send } from './delivery'
import type { Subscription, SubscriptionState } from './state'

function sendRecovery(state: SubscriptionState, sub: Subscription, frame: HostFrame) {
  return send(state, sub, frame, (value) => reset(state, value))
}

export function reset(state: SubscriptionState, sub: Subscription, initial = false) {
  if (sub.request.topic === 'lane') {
    const result = state.streams.snapshot(sub.request.laneId)
    if (!result) return fail(state, sub.request, 'unknown-lane')
    if (!result.ok) return fail(state, sub.request, 'too-large')
    const sent = sendRecovery(state, sub, {
      type: 'snapshot',
      id: sub.request.id,
      laneId: sub.request.laneId,
      reset: !initial || sub.request.after !== undefined,
      snapshot: result.snapshot,
    })
    if (sent === 'large') return fail(state, sub.request, 'too-large')
    if (sent !== 'sent') return
    sub.cursor = result.snapshot.cursor
  } else {
    const frame = state.lanesTopic.snapshot()
    if (!sub.recovery || sub.recovery.cursor.seq !== frame.cursor.seq) {
      const after = sub.recovery ? sub.recovery.after : (sub.cursor ?? sub.request.after)
      const sent = sendRecovery(state, sub, { ...frame, id: sub.request.id })
      if (sent === 'large') return fail(state, sub.request, 'too-large')
      if (sent !== 'sent') return
      sub.recovery = { cursor: frame.cursor, after }
      sub.cursor = frame.cursor
    }
    // Historical attention is sent directly, independently of the live cut.
    for (const attention of state.lanesTopic.replay(sub.recovery.after)) {
      const delivered = sendRecovery(state, sub, { ...attention, id: sub.request.id })
      if (delivered === 'large') return fail(state, sub.request, 'too-large')
      if (delivered !== 'sent') return
      sub.recovery.after = attention.cursor
    }
    sub.recovery = undefined
  }
  sub.stale = false
  clearIdleTimer(state)
}
