import type { SessionPush } from '@phosphor/shared/models'
import {
  createLaneProjection,
  type LaneProjection,
} from '@phosphor/session-runtime/lanes/projection'
import { createHostLaneProjection } from '../projection-host'
import type { Attachment, LiveState } from './state'
import { summaryFor } from './summary'
import { changed, publish } from './publication'

export function attach(state: LiveState, laneId: string, sessionId: string) {
  if (state.attached.has(laneId)) throw new Error('lane already attached')
  const last = summaryFor(state, laneId)
  if (!last) throw new Error('unknown lane')
  if (state.attached.size >= state.limits.lanesPerHost)
    throw new Error('live lane capacity reached')
  const projection = createLaneProjection({
    now: state.options.now,
    overflow: () => {
      void binding.refresh()
    },
  })
  // Refreshes and dialog timeouts change visible summaries without another pi push.
  const observed: LaneProjection = {
    ...projection,
    setState(sessionState) {
      projection.setState(sessionState)
      changed(state, laneId)
    },
    settle(messages, sessionState) {
      projection.settle(messages, sessionState)
      changed(state, laneId)
    },
    resolveDialog(id) {
      projection.resolveDialog(id)
      if (!state.resolvingCommand) changed(state, laneId)
    },
  }
  const binding = createHostLaneProjection({
    runtime: state.options.runtime,
    sessionId,
    laneId,
    projection: observed,
    summary: () => summaryFor(state, laneId) ?? last,
    cursor: () => state.streams.cursor(laneId),
    log: state.options.log,
  })
  const live: Attachment = {
    sessionId,
    projection: observed,
    binding,
    last,
    run: false,
    ended: false,
    exited: false,
    changing: false,
    dirty: false,
    reconciliationPending: false,
  }
  state.attached.set(laneId, live)
  changed(state, laneId)
  const ready = binding.refresh().then(() => {
    if (state.attached.get(laneId) === live) state.streams.reset(laneId)
  })
  return { ready, refresh: binding.refresh, stateChanged: binding.stateChanged }
}
export function push(state: LiveState, laneId: string, push: SessionPush) {
  const live = state.attached.get(laneId)
  if (!live || live.exited || push.kind === 'stderr' || push.kind === 'resync') return
  if (push.kind === 'event') {
    if (push.event.type === 'message_end' && push.event.message.role === 'assistant') {
      live.receiptAssistantFailed =
        push.event.message.stopReason === 'error' || !!push.event.message.errorMessage
    }
    if (push.event.type === 'agent_start') {
      if (live.receiptStartedAt === undefined) live.receiptAssistantFailed = false
      live.receiptStartedAt ??= state.options.now()
      live.run = true
      live.ended = false
    } else if (
      push.event.type === 'agent_settled' ||
      (push.event.type === 'agent_end' && !push.event.willRetry)
    ) {
      if (live.receiptStartedAt !== undefined)
        live.receiptTiming = { start: live.receiptStartedAt, end: state.options.now() }
      if (push.event.type === 'agent_settled') live.receiptStartedAt = undefined
      live.ended = true
    }
  }
  live.binding.deliver(push)
  state.streams.publish(laneId, { kind: 'pi', push })
  if (push.kind === 'exit') live.exited = true
  changed(state, laneId)
}
export function detach(state: LiveState, laneId: string) {
  const before = summaryFor(state, laneId)
  state.attached.get(laneId)?.binding.dispose()
  state.attached.delete(laneId)
  const summary = summaryFor(state, laneId)
  if (summary && JSON.stringify(before) !== JSON.stringify(summary))
    publish(state, laneId, { kind: 'summary', summary })
}
