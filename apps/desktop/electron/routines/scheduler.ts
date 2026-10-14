import { RoutineScheduler as PortableScheduler } from '@phosphor/session-runtime/routines/scheduler'
import { shutdownApproval } from '../shutdown-approval'
import type { RoutineRun } from '@shared/routines'
import type { RoutineRepository } from './repository'
import type { RoutineExecutor } from '@phosphor/session-runtime/routines/scheduler'
export type { RoutineExecutor } from '@phosphor/session-runtime/routines/scheduler'

/** Desktop keeps its shutdown approval gate for every scheduler caller. */
export class RoutineScheduler extends PortableScheduler {
  constructor(
    repository: RoutineRepository,
    execute: RoutineExecutor,
    changed: () => void = () => {},
    now: () => number = Date.now,
    notify: (run: RoutineRun) => void = () => {},
  ) {
    super(repository, execute, changed, now, notify, shutdownApproval)
  }
}
