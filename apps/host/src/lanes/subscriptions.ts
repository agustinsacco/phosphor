import {
  type ClientFrame,
  type FrameSocket,
  type HostFrame,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import { streamLimits, type LaneStreams, type LanesTopic, type StreamLimits } from './stream'

type Subscribe = Extract<ClientFrame, { type: 'subscribe' }>
type Subscription = {
  request: Subscribe
  stale: boolean
  cursor?: StreamCursor
  recovery?: { cursor: StreamCursor; after?: StreamCursor }
  drop(): void
}
type Failure = Extract<HostFrame, { type: 'subscribe-failed' }>['code']

/** Auth and parsing belong to 21b. This manager accepts only admitted topic frames. */
export function createSubscriptions(
  socket: FrameSocket,
  streams: LaneStreams,
  lanesTopic: LanesTopic,
  input: Partial<StreamLimits> = {},
  log: (
    message: string,
    data: { topic: Subscribe['topic']; code: Failure; trace?: string },
  ) => void = () => {},
) {
  const limits = streamLimits(input)
  const subscriptions = new Map<string, Subscription>()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  function remove(id: string) {
    subscriptions.get(id)?.drop()
    subscriptions.delete(id)
    if (![...subscriptions.values()].some((s) => s.stale)) {
      clearInterval(timer)
      timer = undefined
    }
  }
  function close() {
    closed = true
    for (const sub of subscriptions.values()) sub.drop()
    subscriptions.clear()
    clearInterval(timer)
    timer = undefined
  }
  function sendFailed() {
    try {
      socket.close(4429, 'Send failed')
    } catch {
      /* Best effort: the manager must close even if the transport throws. */
    }
    close()
  }
  function covered(sub: Subscription, cursor: StreamCursor) {
    return sub.cursor?.epoch === cursor.epoch && cursor.seq <= sub.cursor.seq
  }
  function fail(request: Subscribe, code: Failure, end = true) {
    if (end) remove(request.id)
    try {
      log('lanes.subscribe_failed', { topic: request.topic, code, trace: request.trace })
    } catch {
      /* Safe metadata only. */
    }
    try {
      if (!closed && socket.isOpen()) {
        const text = JSON.stringify({ type: 'subscribe-failed', id: request.id, code })
        if (socket.bufferedBytes() + Buffer.byteLength(text) > limits.sendQueueBytes) {
          socket.close(4429, 'Subscription queue full')
          close()
        } else socket.send(text)
      }
    } catch {
      sendFailed()
    }
  }
  function stale(sub: Subscription) {
    sub.stale = true
    // No private queue: once stale, all incremental frames are discarded.
    if (!timer) {
      timer = setInterval(() => {
        if (!socket.isOpen()) return close()
        if (socket.bufferedBytes() < limits.sendQueueBytes / 2) {
          for (const value of subscriptions.values()) if (value.stale) reset(value)
        }
      }, 25)
      timer.unref()
    }
  }
  function send(sub: Subscription, frame: HostFrame): 'sent' | 'stale' | 'large' {
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch {
      return 'large'
    }
    const bytes = Buffer.byteLength(text)
    if (bytes > limits.outboundFrameBytes || bytes > limits.sendQueueBytes) return 'large'
    // Check the prospective backlog too: never hand the transport an unbounded queue.
    if (socket.bufferedBytes() + bytes > limits.sendQueueBytes) {
      stale(sub)
      return 'stale'
    }
    try {
      if (closed || !socket.isOpen()) {
        close()
        return 'stale'
      }
      socket.send(text)
      return 'sent'
    } catch {
      sendFailed()
      return 'stale'
    }
  }
  function reset(sub: Subscription, initial = false) {
    if (sub.request.topic === 'lane') {
      const result = streams.snapshot(sub.request.laneId)
      if (!result) return fail(sub.request, 'unknown-lane')
      if (!result.ok) return fail(sub.request, 'too-large')
      const sent = send(sub, {
        type: 'snapshot',
        id: sub.request.id,
        laneId: sub.request.laneId,
        reset: !initial || sub.request.after !== undefined,
        snapshot: result.snapshot,
      })
      if (sent === 'large') return fail(sub.request, 'too-large')
      if (sent !== 'sent') return
      sub.cursor = result.snapshot.cursor
    } else {
      const frame = lanesTopic.snapshot()
      if (!sub.recovery || sub.recovery.cursor.seq !== frame.cursor.seq) {
        const after = sub.recovery ? sub.recovery.after : (sub.cursor ?? sub.request.after)
        const sent = send(sub, { ...frame, id: sub.request.id })
        if (sent === 'large') return fail(sub.request, 'too-large')
        if (sent !== 'sent') return
        sub.recovery = { cursor: frame.cursor, after }
        sub.cursor = frame.cursor
      }
      // Historical attention is sent directly, independently of the live cut.
      for (const attention of lanesTopic.replay(sub.recovery.after)) {
        const delivered = send(sub, { ...attention, id: sub.request.id })
        if (delivered === 'large') return fail(sub.request, 'too-large')
        if (delivered !== 'sent') return
        sub.recovery.after = attention.cursor
      }
      sub.recovery = undefined
    }
    sub.stale = false
    if (![...subscriptions.values()].some((s) => s.stale)) {
      clearInterval(timer)
      timer = undefined
    }
  }
  function handle(frame: Subscribe | Extract<ClientFrame, { type: 'unsubscribe' }>) {
    if (closed) return
    if (frame.type === 'unsubscribe') return remove(frame.id)
    if (subscriptions.has(frame.id)) return fail(frame, 'bad-request', false)
    if (subscriptions.size >= limits.subscriptionsPerConnection)
      return fail(frame, 'too-many', false)
    if (frame.topic === 'lane' && !streams.snapshot(frame.laneId))
      return fail(frame, 'unknown-lane', false)
    const sub: Subscription = { request: frame, stale: false, drop: () => {} }
    subscriptions.set(frame.id, sub)
    if (frame.topic === 'lane') {
      sub.drop = streams.listen(frame.laneId, (event) => {
        if (sub.stale) return
        if (!event) return reset(sub)
        if (covered(sub, event.cursor)) return
        const sent = send(sub, { ...event, id: frame.id })
        if (sent === 'large') return reset(sub)
        if (sent === 'sent') sub.cursor = event.cursor
      })
      const replay = frame.after ? streams.replay(frame.laneId, frame.after) : null
      if (replay === null) reset(sub, true)
      else {
        sub.cursor = frame.after
        for (const event of replay) {
          const sent = send(sub, { ...event, id: frame.id })
          if (sent === 'large') {
            reset(sub)
            break
          }
          if (sent !== 'sent') break
          sub.cursor = event.cursor
        }
      }
    } else {
      sub.drop = lanesTopic.listen((event) => {
        if (sub.stale) return
        if (!event) return reset(sub)
        if (covered(sub, event.cursor)) return
        const sent = send(sub, { ...event, id: frame.id })
        if (sent === 'large') return reset(sub)
        if (sent === 'sent') sub.cursor = event.cursor
      })
      reset(sub, true)
    }
  }
  socket.onClose(close)
  return { handle, close, queuedBytes: () => 0, size: () => subscriptions.size }
}
