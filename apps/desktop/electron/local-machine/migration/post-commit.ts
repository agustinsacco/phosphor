import type { MigrationJournal, PostCommitStep } from './journal'
import type { MigrationPlan } from './plan'

/**
 * Steps 15 and 16 (`device`, `quarantine`) run after the commit point, from
 * the backup and the plan alone. The runner (M3) calls the step table M4
 * provides; with no entry a step stays pending and is replayed next launch.
 * Every step is repeatable: a crash part-way through reruns it whole.
 */
export interface PostCommitInput {
  readonly userData: string
  /** `committed` or later; `machineId` is set. */
  readonly journal: MigrationJournal
  readonly plan: MigrationPlan
  readonly backupDir: string
  /** Fixed event names and counts only, never a path or a message. */
  readonly log: (event: string, data?: Readonly<Record<string, number | string>>) => void
}

export type PostCommitRun = (input: PostCommitInput) => Promise<void>

export type PostCommitSteps = Readonly<Partial<Record<PostCommitStep, PostCommitRun>>>
