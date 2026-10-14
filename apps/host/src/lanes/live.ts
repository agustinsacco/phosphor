import {
  isLaneBranchName,
  parseHostFrame,
  type HostFrame,
  type AttentionKind,
  type LaneEvent,
  type LaneSummary,
} from '@phosphor/shared/host-protocol'
import { normalizeLabel } from '@phosphor/shared/control-api'
import type { SessionPush } from '@phosphor/shared/models'
import {
  createLaneProjection,
  type LaneProjection,
} from '@phosphor/session-runtime/lanes/projection'
import { createHostLaneProjection, type SnapshotResult } from './projection-host'
import { type HostStore } from './store'
import { createLaneStreams, createLanesTopic, streamLimits, type StreamLimits } from './stream'

type Attachment = {
  sessionId: string
  projection: LaneProjection
  binding: ReturnType<typeof createHostLaneProjection>
  last: LaneSummary
  run: boolean
  ended: boolean
  exited: boolean
  changing: boolean
  dirty: boolean
  reconciliationPending: boolean
}

export function createLiveLanes(options: {
  epoch: string
  store: Pick<HostStore, 'getLane' | 'listLanes' | 'listRepositories' | 'bumpAttention'>
  runtime: Parameters<typeof createHostLaneProjection>[0]['runtime']
  now(): number
  log(
    message: string,
    data: { laneId: string; reason?: 'rpc' | 'shape' | 'size' } | { topic: 'lanes' },
  ): void
  limits?: Partial<StreamLimits>
  unattached?(laneId: string): SnapshotResult | null
}) {
  const limits = streamLimits(options.limits)
  const attached = new Map<string, Attachment>()
  // Tokens exist only during synchronous summary publication, including detached lanes.
  const summaryPublications = new Map<string, object>()
  let resolvingCommand = false
  function invalid(laneId: string) {
    try {
      options.log('lane.summary_invalid', { laneId })
    } catch {
      /* No values in logs. */
    }
  }
  function valid(frame: HostFrame, laneId: string): boolean {
    try {
      if (parseHostFrame(JSON.stringify(frame)).ok) return true
    } catch {
      /* Fail closed. */
    }
    invalid(laneId)
    return false
  }
  const title = (value: string | null | undefined) =>
    value != null && normalizeLabel(value) === value ? value : null
  const model = (value: LaneSummary['model'] | undefined) =>
    value &&
    value.provider.length >= 1 &&
    value.provider.length <= 200 &&
    value.id.length >= 1 &&
    value.id.length <= 200
      ? value
      : null
  function validSummary(summary: LaneSummary) {
    return valid(
      {
        type: 'lanes-delta',
        id: 'check',
        cursor: { epoch: options.epoch, seq: 1 },
        upsert: [summary],
        remove: [],
      },
      summary.laneId,
    )
  }
  function summaryFor(laneId: string): LaneSummary | null {
    const stored = options.store.getLane(laneId)
    if (!stored || stored.removedAt !== null) return null
    const { sessionFile: _sessionFile, removedAt: _removedAt, ...summary } = stored
    const live = attached.get(laneId)
    const state = live?.projection.view().state
    const candidate: LaneSummary = {
      ...summary,
      activity: live?.projection.activity() ?? summary.activity,
      title: title(state?.sessionName) ?? title(summary.title),
      model: model(state?.model) ?? model(summary.model),
      branch: isLaneBranchName(summary.branch) ? summary.branch : null,
    }
    return validSummary(candidate) ? candidate : (live?.last ?? null)
  }
  const streams = createLaneStreams({
    epoch: options.epoch,
    limits,
    log: options.log,
    snapshot(laneId) {
      if (!summaryFor(laneId)) return null
      const live = attached.get(laneId)
      // 21b supplies on-disk transcripts for lanes without a live projection.
      return live ? live.binding.snapshot() : (options.unattached?.(laneId) ?? null)
    },
  })
  const lanesTopic = createLanesTopic({
    epoch: options.epoch,
    limits,
    invalid,
    log: options.log,
    list: () => ({
      repositories: options.store.listRepositories(),
      lanes: options.store.listLanes().flatMap((lane) => summaryFor(lane.laneId) ?? []),
    }),
  })
  function publish(laneId: string, event: LaneEvent) {
    const live = attached.get(laneId)
    if (event.kind === 'summary' && !validSummary(event.summary)) return
    if (event.kind === 'dialog-resolved') {
      resolvingCommand = true
      try {
        live?.binding.resolveDialog(event.dialogId)
      } finally {
        resolvingCommand = false
      }
    }
    if (event.kind === 'summary' && live) live.last = event.summary
    const publication = {}
    if (event.kind === 'summary') summaryPublications.set(laneId, publication)
    try {
      streams.publish(laneId, event)
      if (event.kind === 'dialog-resolved') changed(laneId)
      if (event.kind === 'control') {
        const summary = summaryFor(laneId)
        if (summary) publish(laneId, { kind: 'summary', summary })
      } else if (event.kind === 'summary' && summaryPublications.get(laneId) === publication) {
        lanesTopic.delta([event.summary])
      }
    } finally {
      if (summaryPublications.get(laneId) === publication) summaryPublications.delete(laneId)
    }
  }
  function changed(laneId: string) {
    const live = attached.get(laneId)
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
        if (++passes > limits.replayEvents) {
          try {
            options.log('lane.stream_reentrant_overflow', { laneId })
          } catch {
            /* Logging cannot stop pi. */
          }
          if (!live.reconciliationPending) {
            live.reconciliationPending = true
            setImmediate(() => {
              live.reconciliationPending = false
              if (attached.get(laneId) === live) changed(laneId)
            })
          }
          break
        }
        let summary = summaryFor(laneId)
        if (!summary) return
        let kind: AttentionKind | undefined
        if (summary.activity !== live.last.activity) {
          if (summary.activity === 'needs-input') kind = 'needs-input'
          else if (summary.activity === 'failed') kind = 'failed'
        }
        if (summary.activity === 'idle' && live.run && live.ended) {
          kind = 'finished'
          live.run = live.ended = false
        }
        if (kind) summary = { ...summary, attention: options.store.bumpAttention(laneId) }
        const different = JSON.stringify(summary) !== JSON.stringify(live.last)
        live.last = summary
        if (kind) {
          lanesTopic.attention({
            id: `${laneId}:${summary.attention}`,
            laneId,
            attention: summary.attention,
            kind,
            at: new Date(options.now()).toISOString(),
            title: summary.title,
          })
        }
        if (different && attached.get(laneId) === live && live.last === summary)
          publish(laneId, { kind: 'summary', summary })
      } while (live.dirty && attached.get(laneId) === live)
    } finally {
      live.changing = false
    }
  }
  function attach(laneId: string, sessionId: string) {
    if (attached.has(laneId)) throw new Error('lane already attached')
    const last = summaryFor(laneId)
    if (!last) throw new Error('unknown lane')
    if (attached.size >= limits.lanesPerHost) throw new Error('live lane capacity reached')
    const projection = createLaneProjection({
      now: options.now,
      overflow: () => {
        void binding.refresh()
      },
    })
    // Refreshes and dialog timeouts change visible summaries without another pi push.
    const observed: LaneProjection = {
      ...projection,
      setState(state) {
        projection.setState(state)
        changed(laneId)
      },
      settle(messages, state) {
        projection.settle(messages, state)
        changed(laneId)
      },
      resolveDialog(id) {
        projection.resolveDialog(id)
        if (!resolvingCommand) changed(laneId)
      },
    }
    const binding = createHostLaneProjection({
      runtime: options.runtime,
      sessionId,
      laneId,
      projection: observed,
      summary: () => summaryFor(laneId) ?? last,
      cursor: () => streams.cursor(laneId),
      log: options.log,
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
    attached.set(laneId, live)
    changed(laneId)
    const ready = binding.refresh().then(() => {
      if (attached.get(laneId) === live) streams.reset(laneId)
    })
    return { ready, refresh: binding.refresh, stateChanged: binding.stateChanged }
  }
  function push(laneId: string, push: SessionPush) {
    const live = attached.get(laneId)
    if (!live || live.exited || push.kind === 'stderr' || push.kind === 'resync') return
    if (push.kind === 'event') {
      if (push.event.type === 'agent_start') {
        live.run = true
        live.ended = false
      } else if (
        push.event.type === 'agent_settled' ||
        (push.event.type === 'agent_end' && !push.event.willRetry)
      )
        live.ended = true
    }
    live.binding.deliver(push)
    streams.publish(laneId, { kind: 'pi', push })
    if (push.kind === 'exit') live.exited = true
    changed(laneId)
  }
  function detach(laneId: string) {
    const before = summaryFor(laneId)
    attached.get(laneId)?.binding.dispose()
    attached.delete(laneId)
    const summary = summaryFor(laneId)
    if (summary && JSON.stringify(before) !== JSON.stringify(summary))
      publish(laneId, { kind: 'summary', summary })
  }
  return {
    streams,
    lanesTopic,
    attach,
    push,
    publish,
    summaryFor,
    sessionFor: (laneId: string) => {
      const live = attached.get(laneId)
      return live && !live.exited ? live.sessionId : null
    },
    openDialogs: (laneId: string) =>
      attached
        .get(laneId)
        ?.projection.view()
        .dialogs.map((d) => d.id) ?? [],
    detach,
    forget(laneId: string) {
      detach(laneId)
      lanesTopic.delta([], [laneId])
      streams.forget(laneId)
    },
    close() {
      for (const laneId of attached.keys()) detach(laneId)
    },
  }
}
