import type { SessionPush } from '@phosphor/shared/models'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../../session/runtime'
import type { createLaneNamer } from '../naming'
import type { createLiveLanes } from '../live'
import type { HostStore } from '../store'

export const MODEL_TRANSCRIPT_REFUSAL =
  'The lane transcript could not be verified. Model was not changed.'
export type Binding = {
  switching?: boolean
  namingEligible?: boolean
  namingConsidered?: boolean
  renameRevision?: number
  laneId?: string
  pushes: SessionPush[]
  bytes: number
  overflow: boolean
  attachment?: ReturnType<ReturnType<typeof createLiveLanes>['attach']>
}

export type RuntimeLaneOptions = {
  runtime: Pick<HostRuntime, 'start' | 'stop' | 'command' | 'extensionUiResponse'>
  store: Pick<HostStore, 'getLane' | 'updateLane' | 'bindSessionFile'>
  live: ReturnType<typeof createLiveLanes>
  nameLane?: (...args: Parameters<ReturnType<typeof createLaneNamer>>) => void
  log: RuntimeLog
}
export type RuntimeLaneState = {
  options: RuntimeLaneOptions
  bindings: Map<string, Binding>
}
