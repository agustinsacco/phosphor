import type { StoppedComposer, StreamCursor } from '@phosphor/shared/host-protocol'
import type { HostConnectionSnapshot, LaneFrame } from './connection'

export type LaneWatch = {
  laneId: string
  cursor?: StreamCursor
  stoppedComposer?: StoppedComposer | undefined
  listener: (frame: LaneFrame) => void
}

/** Metadata belongs to the watched lane, not to the independently updated lanes list. */
export function connectionView(
  view: HostConnectionSnapshot,
  watches: Iterable<LaneWatch>,
  epoch: string,
): HostConnectionSnapshot {
  const recorded = new Map<string, StoppedComposer>()
  for (const w of watches)
    if (w.stoppedComposer && w.cursor?.epoch === epoch) recorded.set(w.laneId, w.stoppedComposer)
  if (!recorded.size) return structuredClone(view)
  return structuredClone({
    ...view,
    lanes: view.lanes.map((lane) => {
      const saved = recorded.get(lane.laneId)
      return saved && (lane.activity === 'stopped' || lane.activity === 'failed')
        ? { ...lane, stoppedComposer: saved }
        : lane
    }),
  })
}

export function acceptLaneFrame(
  watch: LaneWatch | undefined,
  frame: LaneFrame,
  view: HostConnectionSnapshot,
  update: (view: Partial<HostConnectionSnapshot>) => void,
  subscribe: (id: string, laneId: string) => void,
): boolean {
  if (!watch || (frame.type !== 'subscribe-failed' && frame.laneId !== watch.laneId)) return false
  if (frame.type === 'event') {
    const { cursor, event } = frame
    if (
      !watch.cursor ||
      watch.cursor.epoch !== cursor.epoch ||
      cursor.seq !== watch.cursor.seq + 1
    ) {
      subscribe(frame.id, watch.laneId)
      return true
    }
    watch.cursor = cursor
    if (event.kind === 'summary' || event.kind === 'control') {
      if (
        event.kind === 'summary' &&
        event.summary.activity !== 'stopped' &&
        event.summary.activity !== 'failed'
      )
        watch.stoppedComposer = undefined
      update({
        lanes: view.lanes.map((lane) =>
          lane.laneId !== frame.laneId
            ? lane
            : event.kind === 'summary'
              ? event.summary
              : { ...lane, control: event.control },
        ),
      })
    }
  } else if (frame.type === 'snapshot') {
    const { cursor, summary, stoppedComposer } = frame.snapshot
    const reset = frame.reset || (!!watch.cursor && watch.cursor.epoch !== cursor.epoch)
    watch.cursor = cursor
    watch.stoppedComposer = stoppedComposer
    update({ lanes: view.lanes.map((lane) => (lane.laneId === frame.laneId ? summary : lane)) })
    watch.listener({ ...frame, reset })
    return true
  } else {
    watch.stoppedComposer = undefined
  }
  watch.listener(frame)
  return true
}
