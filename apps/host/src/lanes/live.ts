import { createLaneStreams, createLanesTopic, streamLimits } from './stream'
import type { LiveOptions, LiveState } from './live/state'
import { invalidSummary, promptTitle, summaryFor } from './live/summary'
import { changed, publish } from './live/publication'
import { attach, detach, push } from './live/attachments'
import { createRepositoryGit } from './live/repository-git'

export { promptTitle } from './live/summary'

export function createLiveLanes(options: LiveOptions) {
  const limits = streamLimits(options.limits)
  const git = createRepositoryGit({
    probe: options.gitTracking,
    changed: () => state.lanesTopic.repositoriesChanged(),
  })
  const repositories = () => git.annotate(options.store.listRepositories())
  const state: LiveState = {
    options,
    limits,
    attached: new Map(),
    summaryPublications: new Map(),
    resolvingCommand: false,
    streams: createLaneStreams({
      epoch: options.epoch,
      limits,
      log: options.log,
      snapshot(laneId) {
        if (!summaryFor(state, laneId)) return null
        const live = state.attached.get(laneId)
        // On-disk transcripts supply lanes without a live projection.
        return live ? live.binding.snapshot() : (options.unattached?.(laneId) ?? null)
      },
    }),
    lanesTopic: createLanesTopic({
      epoch: options.epoch,
      limits,
      invalid: (laneId) => invalidSummary(state, laneId),
      log: options.log,
      list: () => ({
        repositories: repositories(),
        lanes: options.store.listLanes().flatMap((lane) => summaryFor(state, lane.laneId) ?? []),
      }),
    }),
  }
  // With a probe, ask git at startup so the first snapshot a client gets already says.
  repositories()
  return {
    streams: state.streams,
    lanesTopic: state.lanesTopic,
    attach: attach.bind(null, state),
    push: push.bind(null, state),
    publish: publish.bind(null, state),
    summaryFor: summaryFor.bind(null, state),
    firstPrompt(laneId: string, message: string) {
      const live = state.attached.get(laneId)
      if (!live || live.firstPrompt) return
      live.firstPrompt = promptTitle(message) ?? undefined
      changed(state, laneId)
    },
    sessionFor: (laneId: string) => {
      const live = state.attached.get(laneId)
      return live && !live.exited ? live.sessionId : null
    },
    repositories,
    receiptTiming: (laneId: string) => state.attached.get(laneId)?.receiptTiming,
    openDialogs: (laneId: string) =>
      state.attached
        .get(laneId)
        ?.projection.view()
        .dialogs.map((d) => d.id) ?? [],
    detach: detach.bind(null, state),
    forget(laneId: string) {
      detach(state, laneId)
      state.lanesTopic.delta([], [laneId])
      state.streams.forget(laneId)
    },
    close() {
      for (const laneId of state.attached.keys()) detach(state, laneId)
    },
  }
}
