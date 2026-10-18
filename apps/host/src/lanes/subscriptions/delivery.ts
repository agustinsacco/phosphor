import type { HostFrame } from '@phosphor/shared/host-protocol'
import type {
  Failure,
  RecoverSubscription,
  Subscribe,
  Subscription,
  SubscriptionState,
} from './state'

export function remove(state: SubscriptionState, id: string) {
  state.subscriptions.get(id)?.drop()
  state.subscriptions.delete(id)
  clearIdleTimer(state)
}

export function close(state: SubscriptionState) {
  state.closed = true
  for (const sub of state.subscriptions.values()) sub.drop()
  state.subscriptions.clear()
  clearInterval(state.timer)
  state.timer = undefined
}

export function sendFailed(state: SubscriptionState) {
  try {
    state.socket.close(4429, 'Send failed')
  } catch {
    /* Best effort: the manager must close even if the transport throws. */
  }
  close(state)
}

export function fail(state: SubscriptionState, request: Subscribe, code: Failure, end = true) {
  if (end) remove(state, request.id)
  try {
    state.log('lanes.subscribe_failed', { topic: request.topic, code, trace: request.trace })
  } catch {
    /* Safe metadata only. */
  }
  try {
    if (!state.closed && state.socket.isOpen()) {
      const text = JSON.stringify({ type: 'subscribe-failed', id: request.id, code })
      if (state.socket.bufferedBytes() + Buffer.byteLength(text) > state.limits.sendQueueBytes) {
        state.socket.close(4429, 'Subscription queue full')
        close(state)
      } else state.socket.send(text)
    }
  } catch {
    sendFailed(state)
  }
}

export function stale(state: SubscriptionState, sub: Subscription, recover: RecoverSubscription) {
  sub.stale = true
  // No private queue: once stale, all incremental frames are discarded.
  if (!state.timer) {
    state.timer = setInterval(() => {
      if (!state.socket.isOpen()) return close(state)
      if (state.socket.bufferedBytes() < state.limits.sendQueueBytes / 2) {
        for (const value of state.subscriptions.values()) if (value.stale) recover(value)
      }
    }, 25)
    state.timer.unref()
  }
}

export function send(
  state: SubscriptionState,
  sub: Subscription,
  frame: HostFrame,
  recover: RecoverSubscription,
): 'sent' | 'stale' | 'large' {
  let text: string
  try {
    text = JSON.stringify(frame)
  } catch {
    return 'large'
  }
  const bytes = Buffer.byteLength(text)
  if (bytes > state.limits.outboundFrameBytes || bytes > state.limits.sendQueueBytes) return 'large'
  // Check the prospective backlog too: never hand the transport an unbounded queue.
  if (state.socket.bufferedBytes() + bytes > state.limits.sendQueueBytes) {
    stale(state, sub, recover)
    return 'stale'
  }
  try {
    if (state.closed || !state.socket.isOpen()) {
      close(state)
      return 'stale'
    }
    state.socket.send(text)
    return 'sent'
  } catch {
    sendFailed(state)
    return 'stale'
  }
}

export function clearIdleTimer(state: SubscriptionState) {
  if (![...state.subscriptions.values()].some((sub) => sub.stale)) {
    clearInterval(state.timer)
    state.timer = undefined
  }
}
