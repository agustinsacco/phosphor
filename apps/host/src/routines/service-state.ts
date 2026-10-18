import type { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import type { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import type { HostRuntime } from '../session/runtime'
import type { HostStore } from '../lanes/store'

export interface HostRoutineOptions {
  directory: string
  uid: number | undefined
  store: Pick<HostStore, 'listRepositories'>
  runtime: HostRuntime
  changed(): void
  now?: () => number
}

/** One service owns the scheduler, database and shutdown barrier together. */
export interface HostRoutineState {
  options: HostRoutineOptions
  repository: RoutineRepository
  scheduler: RoutineScheduler
  now: () => number
  closing: boolean
  stopped: Promise<void> | undefined
  closed: boolean
}
