import type { HostFrame, LaneEvent, StreamCursor } from '@phosphor/shared/host-protocol'
import type { StreamLimits, StreamLog } from '../stream'
import { createDispatchState, deliverFrame, type DispatchState, type Listener } from './dispatch'

export type LaneFrame = Omit<Extract<HostFrame, { type: 'event' }>, 'id'>

interface LaneReplay {
  seq: number
  bytes: number
  replay: { frame: LaneFrame; bytes: number }[]
  dispatch: DispatchState<LaneFrame>
}

export interface LaneStreamState {
  epoch: string
  limits: StreamLimits
  log?: StreamLog
  lanes: Map<string, LaneReplay>
}

export function createLaneStreamState(options: Omit<LaneStreamState, 'lanes'>): LaneStreamState {
  return { ...options, lanes: new Map() }
}

function lane(state: LaneStreamState, id: string): LaneReplay {
  let value = state.lanes.get(id)
  if (!value) {
    if (state.lanes.size >= state.limits.lanesPerHost)
      throw new Error('stream lane capacity reached')
    value = {
      seq: 0,
      bytes: 0,
      replay: [],
      dispatch: createDispatchState(state.limits.replayEvents, state.log, { laneId: id }),
    }
    state.lanes.set(id, value)
  }
  return value
}

export function laneCursor(state: LaneStreamState, laneId: string): StreamCursor {
  return { epoch: state.epoch, seq: state.lanes.get(laneId)?.seq ?? 0 }
}

export function publishLane(
  state: LaneStreamState,
  laneId: string,
  event: LaneEvent,
): StreamCursor {
  const value = lane(state, laneId)
  if (value.seq === Number.MAX_SAFE_INTEGER) throw new Error('stream sequence exhausted')
  const frame: LaneFrame = {
    type: 'event',
    laneId,
    cursor: { epoch: state.epoch, seq: ++value.seq },
    event,
  }
  const bytes = Buffer.byteLength(JSON.stringify(frame))
  value.replay.push({ frame, bytes })
  value.bytes += bytes
  while (
    value.replay.length > state.limits.replayEvents ||
    value.bytes > state.limits.replayBytes
  ) {
    const old = value.replay.shift()
    if (old) value.bytes -= old.bytes
  }
  deliverFrame(value.dispatch, frame)
  return frame.cursor
}

export function replayLane(
  state: LaneStreamState,
  laneId: string,
  after: StreamCursor,
): readonly LaneFrame[] | null {
  const value = state.lanes.get(laneId)
  const current = laneCursor(state, laneId)
  const first = value?.replay[0]?.frame.cursor.seq ?? current.seq + 1
  if (after.epoch !== state.epoch || after.seq > current.seq || after.seq < first - 1) return null
  return (
    value?.replay.filter((entry) => entry.frame.cursor.seq > after.seq).map((e) => e.frame) ?? []
  )
}

export function listenLane(
  state: LaneStreamState,
  laneId: string,
  listener: Listener<LaneFrame>,
): () => void {
  const value = lane(state, laneId)
  value.dispatch.listeners.add(listener)
  return () => value.dispatch.listeners.delete(listener)
}

export function resetLane(state: LaneStreamState, laneId: string) {
  const value = state.lanes.get(laneId)
  if (value) deliverFrame(value.dispatch, null)
}

export function forgetLane(state: LaneStreamState, laneId: string) {
  const value = state.lanes.get(laneId)
  state.lanes.delete(laneId)
  if (value) deliverFrame(value.dispatch, null)
}
