import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { LaneProjection } from '@phosphor/session-runtime/lanes/projection'
import type { createHostLaneProjection, SnapshotResult } from '../projection-host'
import type { HostStore } from '../store'
import type { GitProbe } from './repository-git'
import type { LaneStreams, LanesTopic, StreamLimits } from '../stream'

export type Attachment = {
  receiptAssistantFailed?: boolean
  receiptStartedAt?: number
  receiptTiming?: { start: number; end: number }
  firstPrompt?: string
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

export type LiveOptions = {
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
  /** Asks git whether each repository is a checkout. Absent: the field stays out. */
  gitTracking?: GitProbe
}

export type LiveState = {
  options: LiveOptions
  limits: StreamLimits
  attached: Map<string, Attachment>
  // Tokens exist only during synchronous summary publication, including detached lanes.
  summaryPublications: Map<string, object>
  resolvingCommand: boolean
  streams: LaneStreams
  lanesTopic: LanesTopic
}
