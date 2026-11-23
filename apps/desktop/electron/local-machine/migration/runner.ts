import { join } from 'node:path'
import { OwnerCallError } from '@phosphor/host-client/owner'
import type { OwnerIndex, OwnerLaneRow } from '@phosphor/shared/host-protocol-owner'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import { canonicalJson, sha256Hex } from '@phosphor/session-runtime/ops/redact'
import { BackupFailed, backupDirFor, backupUserData } from './backup'
import { rollForward, type CommitOutcome, type CommitPorts } from './commit'
import {
  IMPORT_STEPS,
  newJournal,
  withState,
  withStep,
  type MigrationFailure,
  type MigrationJournal,
  type MigrationStep,
} from './journal'
import type { OwnerChannel } from './owner-channel'
import { buildPlan, sectionHash, writePlan, type MigrationPlan } from './plan'
import type { PlanFacts } from './plan-facts'
import { countRoutines } from './scan-routines'
import { gateCode, verifyMigration, type VerifyPorts } from './verify'
import { takeWitness, writeWitness, readWitness } from './witness'

/**
 * Steps 1-13 of This Mac's move onto its Phosphor service, then the commit
 * (`commit.ts`). Every step is journaled before the next starts, so a crash
 * anywhere converges: before `commit-requested` the next launch aborts the
 * staged attempt and Desktop stays in-app; from `commit-requested` on it only
 * rolls forward. The whole run before the commit point has a 120 s budget and
 * a quit, both of which abort before the commit point and never after it.
 */

export const MIGRATION_BUDGET_MS = 120_000

export interface RunnerPorts extends CommitPorts {
  readonly owner: OwnerChannel
  readonly desktopVersion: string
  /** `routines.sqlite`, or the dev build's own file name. */
  readonly routinesFile: string
  readonly newId: () => string
  readonly scan: (input: {
    migrationId: string
    machineId: string
    backupDir: string
    routinesCopy: string | null
  }) => Promise<PlanFacts>
  readonly archives: () => Promise<readonly ArchiveRecord[]>
  readonly verify: Omit<VerifyPorts, 'witnessNow' | 'copiedRoutines' | 'liveRoutines'>
  readonly desktop: { readonly agentDir: string; readonly sessionsRoot: string }
  readonly budgetMs?: number
  /** Aborts when the user quits during the gate. */
  readonly quit: AbortSignal
}

export type RunOutcome =
  | CommitOutcome
  | { readonly kind: 'aborted'; readonly journal: MigrationJournal; readonly code: string }

/** A step that cannot go on; `code` is the journal's fixed failure code. */
export class StepFailed extends Error {
  constructor(readonly code: string) {
    super(`The migration stopped (${code}).`)
    this.name = 'StepFailed'
  }
}

interface Run {
  readonly ports: RunnerPorts
  readonly signal: AbortSignal
  readonly backupDir: string
  journal: MigrationJournal
}

const iso = (ports: RunnerPorts) => new Date(ports.now()).toISOString()

function save(run: Run, journal: MigrationJournal) {
  run.journal = journal
  run.ports.writer.write(journal)
}

/** `work`, or a rejection as soon as the budget runs out or the user quits. */
function guarded<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new StepFailed(String(signal.reason)))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new StepFailed(String(signal.reason)))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

async function step<T>(
  run: Run,
  name: MigrationStep,
  work: () => Promise<{ value: T; digest?: string }>,
): Promise<T> {
  run.ports.onStep?.(name)
  run.ports.crash?.(name, 'before')
  save(run, withStep(run.journal, name, 'pending', iso(run.ports)))
  const { value, digest } = await guarded(run.signal, work())
  save(run, withStep(run.journal, name, 'done', iso(run.ports), digest))
  run.ports.crash?.(name, 'after')
  return value
}

async function indexPages(owner: OwnerChannel): Promise<OwnerIndex> {
  const first = await owner.call('owner.index', {})
  const lanes: OwnerLaneRow[] = [...first.lanes]
  let next = first.next
  while (next) {
    const page = await owner.call('owner.index', { after: next })
    lanes.push(...page.lanes)
    next = page.next
  }
  return { ...first, lanes, next: undefined }
}

async function stage(run: Run, plan: MigrationPlan): Promise<void> {
  const { owner } = run.ports
  const { migrationId } = run.journal
  for (const name of IMPORT_STEPS) {
    const section = plan.sections[name]
    if (!section) continue
    const hash = sectionHash(section)
    await step(run, name, async () => {
      await owner.call('owner.migrate.import', { migrationId, hash, ...section })
      return { value: undefined, digest: hash }
    })
  }
}

async function verify(run: Run, plan: MigrationPlan, archives: readonly ArchiveRecord[]) {
  const { ports, backupDir } = run
  const live = join(ports.userData, ports.routinesFile)
  const index = await indexPages(ports.owner)
  const result = await verifyMigration(
    {
      plan,
      journal: run.journal,
      index,
      witness: readWitness(backupDir),
      archives,
      desktop: ports.desktop,
      signal: run.signal,
    },
    {
      ...ports.verify,
      witnessNow: () => takeWitness(plan.witness),
      copiedRoutines: () =>
        plan.sections.routines ? countRoutines(plan.sections.routines.database) : 0,
      liveRoutines: () => (ports.verify.exists(live) ? countRoutines(live) : 0),
    },
  )
  if (!result.ok) throw new StepFailed(gateCode(result.gate))
  return { value: undefined }
}

/** Steps 1-12, staged and verified; throws `StepFailed` (or any error) to abort. */
async function prepare(run: Run): Promise<void> {
  const { ports, backupDir } = run
  const { migrationId } = run.journal
  const machineId = run.journal.machineId ?? ''
  await step(run, 'preflight', async () => ({ value: undefined }))
  const manifest = await step(run, 'backup', async () => {
    const made = backupUserData({
      userData: ports.userData,
      backupDir,
      migrationId,
      routinesFile: ports.routinesFile,
    })
    return { value: made, digest: sha256Hex(canonicalJson(made)) }
  })
  const plan = await step(run, 'plan', async () => {
    const routinesCopy = manifest.routines ? join(backupDir, manifest.routines.name) : null
    const built = buildPlan(await ports.scan({ migrationId, machineId, backupDir, routinesCopy }))
    if (built.refusals.length > 0) throw new StepFailed(built.refusals[0]!)
    const digest = writePlan(backupDir, built)
    writeWitness(backupDir, takeWitness(built.witness))
    return { value: built, digest }
  })
  const archives = await ports.archives()
  await step(run, 'begin', async () => {
    await ports.owner.call('owner.migrate.begin', {
      migrationId,
      desktopVersion: ports.desktopVersion,
      ...(run.journal.merge ? { merge: true as const } : {}),
    })
    return { value: undefined }
  })
  await stage(run, plan)
  await step(run, 'verify', () => verify(run, plan, archives))
}

function failureOf(error: unknown, step: MigrationStep): MigrationFailure {
  if (error instanceof StepFailed || error instanceof BackupFailed)
    return { step, code: error.code }
  if (error instanceof OwnerCallError) return { step, code: `service-${error.code}` }
  return { step, code: 'internal' }
}

/** Undo a staged attempt: the service restores its begin snapshot; Desktop is untouched. */
async function abortRun(run: Run, error: unknown): Promise<RunOutcome> {
  const { ports } = run
  const pending = run.journal.steps.find((s) => s.status === 'pending')?.step ?? 'preflight'
  const failure = failureOf(error, pending)
  ports.log('migration.aborted', { step: failure.step, code: failure.code })
  await ports.owner
    .call('owner.migrate.abort', { migrationId: run.journal.migrationId })
    .catch(() => ports.log('migration.abort-unanswered'))
  const counted = failure.code !== 'quit'
  const version = ports.desktopVersion
  const attempts = counted
    ? { ...run.journal.attempts, [version]: (run.journal.attempts[version] ?? 0) + 1 }
    : run.journal.attempts
  const aborted = withState({ ...run.journal, attempts }, 'aborted', iso(ports), failure)
  save(run, aborted)
  return { kind: 'aborted', journal: aborted, code: failure.code }
}

/**
 * One migration attempt from a fresh id. `previous` is the last journal (an
 * aborted, interrupted or consented attempt); its staging is aborted first
 * and its attempt counts carry over.
 */
export async function runMigration(
  ports: RunnerPorts,
  input: { previous: MigrationJournal | null; machineId: string },
): Promise<RunOutcome> {
  const { previous } = input
  if (previous)
    await ports.owner
      .call('owner.migrate.abort', { migrationId: previous.migrationId })
      .catch(() => ports.log('migration.abort-unanswered'))
  const migrationId = ports.newId()
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort('budget'), ports.budgetMs ?? MIGRATION_BUDGET_MS)
  timer.unref?.()
  const onQuit = () => budget.abort('quit')
  if (ports.quit.aborted) onQuit()
  ports.quit.addEventListener('abort', onQuit, { once: true })
  const journal = newJournal({
    migrationId,
    desktopVersion: ports.desktopVersion,
    at: iso(ports),
    attempts: previous?.attempts,
    merge: previous?.state === 'consented' || previous?.merge === true,
  })
  const run: Run = {
    ports,
    signal: budget.signal,
    backupDir: backupDirFor(ports.migrationDir, migrationId),
    journal: { ...journal, machineId: input.machineId },
  }
  try {
    save(run, run.journal)
    try {
      await prepare(run)
      // The last chance to abort: from the next write on, only rolling forward.
      if (budget.signal.aborted) throw new StepFailed(String(budget.signal.reason))
    } catch (error) {
      return await abortRun(run, error)
    }
    ports.onStep?.('commit-request')
    ports.crash?.('commit-request', 'before')
    const at = iso(ports)
    save(
      run,
      withState(withStep(run.journal, 'commit-request', 'done', at), 'commit-requested', at),
    )
    ports.crash?.('commit-request', 'after')
  } finally {
    clearTimeout(timer)
    ports.quit.removeEventListener('abort', onQuit)
  }
  return rollForward(ports, ports.owner, run.journal)
}
