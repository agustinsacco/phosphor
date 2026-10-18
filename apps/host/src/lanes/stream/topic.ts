import {
  parseHostFrame,
  type AttentionEvent,
  type HostFrame,
  type LaneSummary,
  type RepositorySummary,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { StreamLimits, StreamLog } from '../stream'
import { createDispatchState, deliverFrame, type DispatchState, type Listener } from './dispatch'

export type TopicFrame =
  | Omit<Extract<HostFrame, { type: 'routines-changed' }>, 'id'>
  | Omit<Extract<HostFrame, { type: 'lanes-delta' }>, 'id'>
  | Omit<Extract<HostFrame, { type: 'attention' }>, 'id'>
type AttentionFrame = Extract<TopicFrame, { type: 'attention' }>

interface TopicOptions {
  epoch: string
  limits: StreamLimits
  list(): { lanes: readonly LaneSummary[]; repositories: readonly RepositorySummary[] }
  invalid?(laneId: string): void
  log?: StreamLog
}

export interface LanesTopicState extends TopicOptions {
  seq: number
  dispatch: DispatchState<TopicFrame>
  attention: AttentionFrame[]
}

export function createLanesTopicState(options: TopicOptions): LanesTopicState {
  return {
    ...options,
    seq: 0,
    dispatch: createDispatchState(options.limits.replayEvents, options.log, { topic: 'lanes' }),
    attention: [],
  }
}

export function topicCursor(state: LanesTopicState): StreamCursor {
  return { epoch: state.epoch, seq: state.seq }
}

function next(state: LanesTopicState): StreamCursor {
  if (state.seq === Number.MAX_SAFE_INTEGER) throw new Error('stream sequence exhausted')
  state.seq++
  return topicCursor(state)
}

function valid(state: LanesTopicState, frame: TopicFrame): boolean {
  try {
    if (parseHostFrame(JSON.stringify({ ...frame, id: 'check' })).ok) return true
  } catch {
    /* Fail closed. */
  }
  const ids =
    frame.type === 'attention'
      ? [frame.event.laneId]
      : frame.type === 'lanes-delta'
        ? frame.upsert.map((s) => s.laneId)
        : []
  for (const id of ids) {
    try {
      state.invalid?.(id)
    } catch {
      /* Logging cannot stop pi. */
    }
  }
  return false
}

export function topicSnapshot(state: LanesTopicState) {
  return { type: 'lanes' as const, cursor: topicCursor(state), ...state.list() }
}

export function repositoriesChanged(state: LanesTopicState) {
  deliverFrame(state.dispatch, null)
}

export function routinesChanged(state: LanesTopicState) {
  deliverFrame(state.dispatch, { type: 'routines-changed', cursor: next(state) })
}

export function publishDelta(
  state: LanesTopicState,
  upsert: readonly LaneSummary[],
  remove: readonly string[] = [],
) {
  if (
    !valid(state, {
      type: 'lanes-delta',
      cursor: { epoch: state.epoch, seq: state.seq + 1 },
      upsert,
      remove,
    })
  )
    return
  deliverFrame(state.dispatch, { type: 'lanes-delta', cursor: next(state), upsert, remove })
}

export function publishAttention(state: LanesTopicState, event: AttentionEvent) {
  if (
    !valid(state, {
      type: 'attention',
      cursor: { epoch: state.epoch, seq: state.seq + 1 },
      event,
    })
  )
    return
  const frame = { type: 'attention' as const, cursor: next(state), event }
  state.attention.push(frame)
  if (state.attention.length > state.limits.attentionReplay) state.attention.shift()
  deliverFrame(state.dispatch, frame)
}

export function replayAttention(
  state: LanesTopicState,
  after?: StreamCursor,
): readonly AttentionFrame[] {
  return after?.epoch === state.epoch
    ? state.attention.filter((frame) => frame.cursor.seq > after.seq)
    : []
}

export function listenTopic(state: LanesTopicState, listener: Listener<TopicFrame>): () => void {
  state.dispatch.listeners.add(listener)
  return () => state.dispatch.listeners.delete(listener)
}
