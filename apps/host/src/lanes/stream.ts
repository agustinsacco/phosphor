import {
  HOST_LIMITS,
  parseHostFrame,
  type AttentionEvent,
  type HostFrame,
  type LaneEvent,
  type LaneSummary,
  type RepositorySummary,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { SnapshotResult } from './projection-host'

export type StreamLimits = {
  [
    Key in
      | 'replayEvents'
      | 'replayBytes'
      | 'lanesPerHost'
      | 'attentionReplay'
      | 'outboundFrameBytes'
      | 'sendQueueBytes'
      | 'subscriptionsPerConnection'
  ]: number
}

export function streamLimits(input: Partial<StreamLimits> = {}): StreamLimits {
  const limits = { ...HOST_LIMITS, ...input }
  for (const key of Object.keys(input)) {
    if (!(key in HOST_LIMITS)) throw new Error('invalid stream limit')
  }
  for (const key of [
    'replayEvents',
    'replayBytes',
    'lanesPerHost',
    'attentionReplay',
    'outboundFrameBytes',
    'sendQueueBytes',
    'subscriptionsPerConnection',
  ] as const) {
    const n = limits[key]
    if (!Number.isSafeInteger(n) || n < 1 || n > HOST_LIMITS[key])
      throw new Error('invalid stream limit')
  }
  return limits
}

type LaneFrame = Omit<Extract<HostFrame, { type: 'event' }>, 'id'>
type TopicFrame =
  | Omit<Extract<HostFrame, { type: 'lanes-delta' }>, 'id'>
  | Omit<Extract<HostFrame, { type: 'attention' }>, 'id'>
type Listener<T> = (frame: T | null) => void
export type StreamLog = (message: string, data: { laneId: string } | { topic: 'lanes' }) => void
function notify<T>(listeners: Set<Listener<T>>, frame: T | null) {
  // New subscribers start at the current cursor, never with this in-flight frame.
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener(frame)
    } catch {
      /* A viewer never stops another viewer or pi. */
    }
  }
}

function dispatch<T>(listeners: Set<Listener<T>>, limit: number, overflow: () => void) {
  const queue: (T | null)[] = []
  let dispatching = false
  let exceeded = false
  return (frame: T | null) => {
    if (!exceeded) queue.push(frame)
    if (queue.length > limit) {
      exceeded = true
      queue.length = 0
    }
    if (dispatching) return
    dispatching = true
    let drained = 0
    try {
      while (queue.length && !exceeded) {
        if (++drained > limit) {
          exceeded = true
          break
        }
        const next = queue.shift()
        if (next !== undefined) notify(listeners, next)
      }
      if (exceeded) {
        queue.length = 0
        overflow()
        queue.length = 0
      }
    } finally {
      exceeded = dispatching = false
    }
  }
}
function overflow<T>(
  listeners: Set<Listener<T>>,
  log: StreamLog | undefined,
  data: Parameters<StreamLog>[1],
) {
  try {
    log?.('lane.stream_reentrant_overflow', data)
  } catch {
    /* Safe metadata only. */
  }
  notify(listeners, null)
}

export function createLaneStreams(options: {
  epoch: string
  limits?: Partial<StreamLimits>
  snapshot(laneId: string): SnapshotResult | null
  log?: StreamLog
}) {
  if (!/^[0-9a-f]{16}$/.test(options.epoch)) throw new Error('invalid stream epoch')
  const limits = streamLimits(options.limits)
  const lanes = new Map<
    string,
    {
      seq: number
      bytes: number
      replay: { frame: LaneFrame; bytes: number }[]
      listeners: Set<Listener<LaneFrame>>
      deliver(frame: LaneFrame | null): void
    }
  >()
  function lane(id: string) {
    let value = lanes.get(id)
    if (!value) {
      if (lanes.size >= limits.lanesPerHost) throw new Error('stream lane capacity reached')
      const listeners = new Set<Listener<LaneFrame>>()
      value = {
        seq: 0,
        bytes: 0,
        replay: [],
        listeners,
        deliver: dispatch(listeners, limits.replayEvents, () =>
          overflow(listeners, options.log, { laneId: id }),
        ),
      }
      lanes.set(id, value)
    }
    return value
  }
  const cursor = (laneId: string): StreamCursor => ({
    epoch: options.epoch,
    seq: lanes.get(laneId)?.seq ?? 0,
  })
  return {
    cursor,
    snapshot: options.snapshot,
    publish(laneId: string, event: LaneEvent): StreamCursor {
      const value = lane(laneId)
      if (value.seq === Number.MAX_SAFE_INTEGER) throw new Error('stream sequence exhausted')
      const frame: LaneFrame = {
        type: 'event',
        laneId,
        cursor: { epoch: options.epoch, seq: ++value.seq },
        event,
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame))
      value.replay.push({ frame, bytes })
      value.bytes += bytes
      while (value.replay.length > limits.replayEvents || value.bytes > limits.replayBytes) {
        const old = value.replay.shift()
        if (old) value.bytes -= old.bytes
      }
      value.deliver(frame)
      return frame.cursor
    },
    replay(laneId: string, after: StreamCursor): readonly LaneFrame[] | null {
      const value = lanes.get(laneId)
      const current = cursor(laneId)
      const first = value?.replay[0]?.frame.cursor.seq ?? current.seq + 1
      if (after.epoch !== options.epoch || after.seq > current.seq || after.seq < first - 1)
        return null
      return (
        value?.replay.filter((entry) => entry.frame.cursor.seq > after.seq).map((e) => e.frame) ??
        []
      )
    },
    listen(laneId: string, listener: Listener<LaneFrame>): () => void {
      const value = lane(laneId)
      value.listeners.add(listener)
      return () => value.listeners.delete(listener)
    },
    reset(laneId: string) {
      const value = lanes.get(laneId)
      if (value) value.deliver(null)
    },
    forget(laneId: string) {
      const value = lanes.get(laneId)
      lanes.delete(laneId)
      if (value) value.deliver(null)
    },
  }
}
export type LaneStreams = ReturnType<typeof createLaneStreams>

export function createLanesTopic(options: {
  epoch: string
  limits?: Partial<StreamLimits>
  list(): { lanes: readonly LaneSummary[]; repositories: readonly RepositorySummary[] }
  invalid?(laneId: string): void
  log?: StreamLog
}) {
  if (!/^[0-9a-f]{16}$/.test(options.epoch)) throw new Error('invalid stream epoch')
  const limits = streamLimits(options.limits)
  let seq = 0
  const listeners = new Set<Listener<TopicFrame>>()
  const deliver = dispatch(listeners, limits.replayEvents, () =>
    overflow(listeners, options.log, { topic: 'lanes' }),
  )
  const attention: Extract<TopicFrame, { type: 'attention' }>[] = []
  const cursor = (): StreamCursor => ({ epoch: options.epoch, seq })
  function next(): StreamCursor {
    if (seq === Number.MAX_SAFE_INTEGER) throw new Error('stream sequence exhausted')
    seq++
    return cursor()
  }
  function valid(frame: TopicFrame): boolean {
    try {
      if (parseHostFrame(JSON.stringify({ ...frame, id: 'check' })).ok) return true
    } catch {
      /* Fail closed. */
    }
    const ids =
      frame.type === 'attention' ? [frame.event.laneId] : frame.upsert.map((s) => s.laneId)
    for (const id of ids) {
      try {
        options.invalid?.(id)
      } catch {
        /* Logging cannot stop pi. */
      }
    }
    return false
  }
  return {
    cursor,
    snapshot: () => ({ type: 'lanes' as const, cursor: cursor(), ...options.list() }),
    delta(upsert: readonly LaneSummary[], remove: readonly string[] = []) {
      if (
        !valid({
          type: 'lanes-delta',
          cursor: { epoch: options.epoch, seq: seq + 1 },
          upsert,
          remove,
        })
      )
        return
      deliver({ type: 'lanes-delta', cursor: next(), upsert, remove })
    },
    attention(event: AttentionEvent) {
      if (!valid({ type: 'attention', cursor: { epoch: options.epoch, seq: seq + 1 }, event }))
        return
      const frame = { type: 'attention' as const, cursor: next(), event }
      attention.push(frame)
      if (attention.length > limits.attentionReplay) attention.shift()
      deliver(frame)
    },
    replay(after?: StreamCursor): readonly Extract<TopicFrame, { type: 'attention' }>[] {
      return after?.epoch === options.epoch
        ? attention.filter((frame) => frame.cursor.seq > after.seq)
        : []
    },
    listen(listener: Listener<TopicFrame>): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
export type LanesTopic = ReturnType<typeof createLanesTopic>
