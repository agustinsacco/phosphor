import type { ClientFrame, FrameSocket, StreamCursor } from '@phosphor/shared/host-protocol'
import { streamLimits, type LaneStreams, type LanesTopic, type StreamLimits } from './stream'
import { close, fail, remove, send } from './subscriptions/delivery'
import { reset } from './subscriptions/recovery'
import type {
  Subscribe,
  Subscription,
  SubscriptionLog,
  SubscriptionState,
} from './subscriptions/state'

function covered(sub: Subscription, cursor: StreamCursor) {
  return sub.cursor?.epoch === cursor.epoch && cursor.seq <= sub.cursor.seq
}

function listen(state: SubscriptionState, sub: Subscription) {
  const receive = (
    event:
      | Parameters<Parameters<LaneStreams['listen']>[1]>[0]
      | Parameters<Parameters<LanesTopic['listen']>[0]>[0],
  ) => {
    if (sub.stale) return
    if (!event) return reset(state, sub)
    if (covered(sub, event.cursor)) return
    const sent = send(state, sub, { ...event, id: sub.request.id }, (value) => reset(state, value))
    if (sent === 'large') return reset(state, sub)
    if (sent === 'sent') sub.cursor = event.cursor
  }
  sub.drop =
    sub.request.topic === 'lane'
      ? state.streams.listen(sub.request.laneId, receive)
      : state.lanesTopic.listen(receive)
}

function admit(state: SubscriptionState, frame: Subscribe) {
  if (state.subscriptions.has(frame.id)) return fail(state, frame, 'bad-request', false)
  if (state.subscriptions.size >= state.limits.subscriptionsPerConnection)
    return fail(state, frame, 'too-many', false)
  if (frame.topic === 'lane' && !state.streams.snapshot(frame.laneId))
    return fail(state, frame, 'unknown-lane', false)
  const sub: Subscription = { request: frame, stale: false, drop: () => {} }
  state.subscriptions.set(frame.id, sub)
  listen(state, sub)
  if (frame.topic === 'lanes') return reset(state, sub, true)
  const replay = frame.after ? state.streams.replay(frame.laneId, frame.after) : null
  if (replay === null) return reset(state, sub, true)
  sub.cursor = frame.after
  for (const event of replay) {
    const sent = send(state, sub, { ...event, id: frame.id }, (value) => reset(state, value))
    if (sent === 'large') {
      reset(state, sub)
      break
    }
    if (sent !== 'sent') break
    sub.cursor = event.cursor
  }
}

function handle(
  state: SubscriptionState,
  frame: Subscribe | Extract<ClientFrame, { type: 'unsubscribe' }>,
) {
  if (state.closed) return
  if (frame.type === 'unsubscribe') return remove(state, frame.id)
  admit(state, frame)
}

/** Auth and parsing belong to 21b. This manager accepts only admitted topic frames. */
export function createSubscriptions(
  socket: FrameSocket,
  streams: LaneStreams,
  lanesTopic: LanesTopic,
  input: Partial<StreamLimits> = {},
  log: SubscriptionLog = () => {},
) {
  const state: SubscriptionState = {
    socket,
    streams,
    lanesTopic,
    limits: streamLimits(input),
    log,
    subscriptions: new Map(),
    closed: false,
  }
  socket.onClose(() => close(state))
  return {
    handle: (frame: Subscribe | Extract<ClientFrame, { type: 'unsubscribe' }>) =>
      handle(state, frame),
    close: () => close(state),
    queuedBytes: () => 0,
    size: () => state.subscriptions.size,
    has: (id: string) => state.subscriptions.has(id),
  }
}
