import {
  HOST_LIMITS,
  type LaneSummary,
  type RepositorySummary,
} from '@phosphor/shared/host-protocol'
import type { SnapshotResult } from './projection-host'
import {
  createLaneStreamState,
  forgetLane,
  laneCursor,
  listenLane,
  publishLane,
  replayLane,
  resetLane,
} from './stream/lane'
import {
  createLanesTopicState,
  listenTopic,
  publishAttention,
  publishDelta,
  replayAttention,
  repositoriesChanged,
  routinesChanged,
  topicCursor,
  topicSnapshot,
} from './stream/topic'

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

export type StreamLog = (message: string, data: { laneId: string } | { topic: 'lanes' }) => void

export function createLaneStreams(options: {
  epoch: string
  limits?: Partial<StreamLimits>
  snapshot(laneId: string): SnapshotResult | null
  log?: StreamLog
}) {
  if (!/^[0-9a-f]{16}$/.test(options.epoch)) throw new Error('invalid stream epoch')
  const state = createLaneStreamState({
    epoch: options.epoch,
    limits: streamLimits(options.limits),
    log: options.log,
  })
  return {
    cursor: laneCursor.bind(null, state),
    snapshot: options.snapshot,
    publish: publishLane.bind(null, state),
    replay: replayLane.bind(null, state),
    listen: listenLane.bind(null, state),
    reset: resetLane.bind(null, state),
    forget: forgetLane.bind(null, state),
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
  const state = createLanesTopicState({ ...options, limits: streamLimits(options.limits) })
  return {
    cursor: topicCursor.bind(null, state),
    snapshot: topicSnapshot.bind(null, state),
    repositoriesChanged: repositoriesChanged.bind(null, state),
    routinesChanged: routinesChanged.bind(null, state),
    delta: publishDelta.bind(null, state),
    attention: publishAttention.bind(null, state),
    replay: replayAttention.bind(null, state),
    listen: listenTopic.bind(null, state),
  }
}
export type LanesTopic = ReturnType<typeof createLanesTopic>
