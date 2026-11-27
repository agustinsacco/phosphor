import type { HostResourceChange } from '@phosphor/shared/host-protocol'
import type { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import type { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import type { HostRuntime } from '../session/runtime'
import type { LaneInput, StoredLane } from '../lanes/store/types'
import type { HostStore } from '../lanes/store'

export interface HostRoutineOptions {
  directory: string
  uid: number | undefined
  store: Pick<HostStore, 'listRepositories'>
  runtime: HostRuntime
  promotion?: {
    sessionsRoot: string
    adopt(input: LaneInput): StoredLane
    publish(id: string): void
  }
  checkPi?(): void
  changed(): void
  resourceChanged?(change: HostResourceChange): void
  now?: () => number
  /** A service pause holds: the scheduler starts no run until it ends. */
  paused?: () => boolean
}

/** One service owns the scheduler, database and shutdown barrier together. */
export interface HostRoutineState {
  options: HostRoutineOptions
  repository: RoutineRepository
  scheduler: RoutineScheduler
  now: () => number
  closing: boolean
  deleting: Set<string>
  stopped: Promise<void> | undefined
  closed: boolean
}
