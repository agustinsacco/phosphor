import type { AttentionKind, LaneEvent, LaneSummary } from '@phosphor/shared/host-protocol'
import type { Attachment, LiveState } from './state'
import { summaryFor, validSummary } from './summary'

function attentionTransition(live: Attachment, summary: LaneSummary): AttentionKind | undefined {
  let kind: AttentionKind | undefined
  if (summary.activity !== live.last.activity) {
    if (summary.activity === 'needs-input') kind = 'needs-input'
    else if (summary.activity === 'failed') kind = 'failed'
  }
  if (summary.activity === 'idle' && live.run && live.ended) {
    kind = live.receiptAssistantFailed ? 'failed' : 'finished'
    live.run = live.ended = false
  }
  return kind
}

export function publish(state: LiveState, laneId: string, event: LaneEvent) {
  const live = state.attached.get(laneId)
  if (event.kind === 'summary' && !validSummary(state, event.summary)) return
  if (event.kind === 'dialog-resolved') {
    state.resolvingCommand = true
    try {
      live?.binding.resolveDialog(event.dialogId)
    } finally {
      state.resolvingCommand = false
    }
  }
  if (event.kind === 'summary' && live) live.last = event.summary
  const publication = {}
  if (event.kind === 'summary') state.summaryPublications.set(laneId, publication)
  try {
    state.streams.publish(laneId, event)
    if (event.kind === 'dialog-resolved') changed(state, laneId)
    if (event.kind === 'control') {
      const summary = summaryFor(state, laneId)
      if (summary) publish(state, laneId, { kind: 'summary', summary })
    } else if (event.kind === 'summary' && state.summaryPublications.get(laneId) === publication) {
      state.lanesTopic.delta([event.summary])
    }
  } finally {
    if (state.summaryPublications.get(laneId) === publication)
      state.summaryPublications.delete(laneId)
  }
}
export function changed(state: LiveState, laneId: string) {
  const live = state.attached.get(laneId)
  if (!live) return
  if (live.changing) {
    live.dirty = true
    return
  }
  live.changing = true
  let passes = 0
  try {
    do {
      live.dirty = false
      if (++passes > state.limits.replayEvents) {
        try {
          state.options.log('lane.stream_reentrant_overflow', { laneId })
        } catch {
          /* Logging cannot stop pi. */
        }
        if (!live.reconciliationPending) {
          live.reconciliationPending = true
          setImmediate(() => {
            live.reconciliationPending = false
            if (state.attached.get(laneId) === live) changed(state, laneId)
          })
        }
        break
      }
      let summary = summaryFor(state, laneId)
      if (!summary) return
      const kind = attentionTransition(live, summary)
      if (kind) summary = { ...summary, attention: state.options.store.bumpAttention(laneId) }
      const different = JSON.stringify(summary) !== JSON.stringify(live.last)
      live.last = summary
      if (kind) {
        state.lanesTopic.attention({
          id: `${laneId}:${summary.attention}`,
          laneId,
          attention: summary.attention,
          kind,
          at: new Date(state.options.now()).toISOString(),
          title: summary.title,
        })
      }
      if (different && state.attached.get(laneId) === live && live.last === summary)
        publish(state, laneId, { kind: 'summary', summary })
    } while (live.dirty && state.attached.get(laneId) === live)
  } finally {
    live.changing = false
  }
}
