import type { AppPrefs } from '@phosphor/shared/models'
import { backupDirFor } from './backup'
import {
  POST_COMMIT_STEPS,
  stepDone,
  withState,
  withStep,
  type JournalWriter,
  type MigrationJournal,
  type MigrationStep,
} from './journal'
import type { OwnerChannel } from './owner-channel'
import { readPlan } from './plan'
import type { PostCommitSteps } from './post-commit'

/**
 * Steps 14-17: the commit and everything after it. Only rolling forward is
 * allowed here: a journal at `commit-requested` asks the service whether it
 * committed and finishes the commit when it is still staged; the post-commit
 * steps (M4's) and `done` replay until they finish. Nothing here ever leads
 * back to the in-app runtime.
 */

export type CrashSide = 'before' | 'after'

export interface CommitPorts {
  readonly userData: string
  readonly migrationDir: string
  readonly writer: JournalWriter
  readonly now: () => number
  readonly postCommit: PostCommitSteps
  readonly writeLocalRuntime: (value: NonNullable<AppPrefs['localRuntime']>) => void
  /** Fixed event names and counts only, never a path or a message. */
  readonly log: (event: string, data?: Readonly<Record<string, number | string>>) => void
  readonly onStep?: (step: MigrationStep) => void
  /** E2E only (`PHOSPHOR_MIGRATION_CRASH_AT`): ends the process at this point. */
  readonly crash?: (step: MigrationStep, side: CrashSide) => void
}

export type CommitOutcome =
  | { readonly kind: 'committed'; readonly journal: MigrationJournal }
  /** The service lost or refused the commit: daemon mode shows it; never in-app. */
  | { readonly kind: 'stuck'; readonly journal: MigrationJournal }

const iso = (ports: CommitPorts) => new Date(ports.now()).toISOString()

function save(ports: CommitPorts, journal: MigrationJournal): MigrationJournal {
  ports.writer.write(journal)
  return journal
}

/** Step 14 when the journal is at `commit-requested`. */
async function finishCommit(
  ports: CommitPorts,
  owner: OwnerChannel,
  journal: MigrationJournal,
): Promise<CommitOutcome> {
  const { migrationId } = journal
  ports.onStep?.('commit')
  ports.crash?.('commit', 'before')
  const { state } = await owner.call('owner.migrate.status', { migrationId })
  if (state === 'staged') await owner.call('owner.migrate.commit', { migrationId })
  else if (state !== 'committed') {
    ports.log('migration.commit-lost', { state })
    const failure = { step: 'commit' as const, code: 'commit-lost' }
    return {
      kind: 'stuck',
      journal: save(ports, withState(journal, journal.state, iso(ports), failure)),
    }
  }
  const committed = save(
    ports,
    withState(withStep(journal, 'commit', 'done', iso(ports)), 'committed', iso(ports)),
  )
  ports.crash?.('commit', 'after')
  return { kind: 'committed', journal: committed }
}

/** Steps 15-16 from the backup and the plan; a step with no entry stays pending. */
async function postCommit(ports: CommitPorts, start: MigrationJournal): Promise<MigrationJournal> {
  let journal = start
  const backupDir = backupDirFor(ports.migrationDir, journal.migrationId)
  const plan = readPlan(backupDir)
  for (const step of POST_COMMIT_STEPS) {
    if (stepDone(journal, step)) continue
    const run = ports.postCommit[step]
    if (!run || !plan) {
      ports.log('migration.step-pending', { step, reason: plan ? 'no-step' : 'no-plan' })
      continue
    }
    ports.onStep?.(step)
    ports.crash?.(step, 'before')
    try {
      await run({ userData: ports.userData, journal, plan, backupDir, log: ports.log })
    } catch {
      ports.log('migration.step-failed', { step })
      continue
    }
    journal = save(ports, withStep(journal, step, 'done', iso(ports)))
    ports.crash?.(step, 'after')
  }
  return journal
}

/** Step 17: the device marker, then the journal's `done`. */
function done(ports: CommitPorts, journal: MigrationJournal): MigrationJournal {
  if (stepDone(journal, 'done')) return journal
  ports.onStep?.('done')
  ports.crash?.('done', 'before')
  ports.writeLocalRuntime({
    mode: 'daemon',
    migrationId: journal.migrationId,
    machineId: journal.machineId ?? '',
    at: iso(ports),
  })
  return save(ports, withStep(journal, 'done', 'done', iso(ports)))
}

/**
 * Rolls a journal at or past `commit-requested` forward. `owner` may be null
 * only once the journal reads `committed`: then nothing needs the service.
 */
export async function rollForward(
  ports: CommitPorts,
  owner: OwnerChannel | null,
  start: MigrationJournal,
): Promise<CommitOutcome> {
  let journal = start
  if (journal.state === 'commit-requested') {
    if (!owner) return { kind: 'stuck', journal }
    const outcome = await finishCommit(ports, owner, journal)
    if (outcome.kind === 'stuck') return outcome
    journal = outcome.journal
  }
  if (journal.state !== 'committed') return { kind: 'stuck', journal }
  journal = await postCommit(ports, journal)
  return { kind: 'committed', journal: done(ports, journal) }
}
