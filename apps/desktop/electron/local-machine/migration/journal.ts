import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { isIsoTime, isUuid } from '@phosphor/shared/control-api'

/**
 * The migration journal: `<userData>/daemon-migration/journal.json`, one
 * record of This Mac's move onto its Phosphor service. Written tmp + fsync +
 * rename, so a reader sees the previous record or the next, never half of
 * one. Its `state` is what the launch gate trusts before anything else after
 * the owner lock: once it reads `commit-requested` the in-app runtime never
 * starts again in this userData.
 */

export const MIGRATION_DIR = 'daemon-migration'
export const JOURNAL_FILE = 'journal.json'

/** D1 §3.7's steps in order. `artifacts` is reconcile-v2 #4's copy, imported beside the others. */
export const MIGRATION_STEPS = [
  'preflight',
  'backup',
  'plan',
  'begin',
  'folders',
  'policy',
  'accounts',
  'lanes',
  'marks',
  'archives',
  'artifacts',
  'routines',
  'verify',
  'commit-request',
  'commit',
  'device',
  'quarantine',
  'done',
] as const
export type MigrationStep = (typeof MIGRATION_STEPS)[number]

/** The sections staged through `owner.migrate.import`, in the order they are sent. */
export const IMPORT_STEPS = [
  'folders',
  'policy',
  'accounts',
  'lanes',
  'marks',
  'archives',
  'artifacts',
  'routines',
] as const satisfies readonly MigrationStep[]
export type ImportStep = (typeof IMPORT_STEPS)[number]

/** Steps after the commit point: derived from the backup and the index, repeatable, M4's. */
export const POST_COMMIT_STEPS = [
  'device',
  'quarantine',
] as const satisfies readonly MigrationStep[]
export type PostCommitStep = (typeof POST_COMMIT_STEPS)[number]

/**
 * - `running`: steps 1-12 under way; an abort still leaves in-app as it was.
 * - `commit-requested`: durable before `owner.migrate.commit` is sent; from here
 *   on only rolling forward is allowed.
 * - `committed`: the service owns This Mac's lanes.
 * - `aborted`: a failure before commit, undone; in-app runs, retried next launch.
 * - `reverted`: the break-glass restore (M4) ran; no automatic migration until Retry.
 * - `consented`: N12, the user agreed to move a running service's Mac; the next
 *   launch migrates with merging imports.
 */
export const JOURNAL_STATES = [
  'running',
  'commit-requested',
  'committed',
  'aborted',
  'reverted',
  'consented',
] as const
export type JournalState = (typeof JOURNAL_STATES)[number]

export interface JournalStep {
  readonly step: MigrationStep
  readonly status: 'pending' | 'done'
  /** The step's result digest (a section hash, the plan hash), when it has one. */
  readonly digest?: string
  readonly at: string
}

export interface MigrationFailure {
  readonly step: MigrationStep
  /** A fixed code, never a path or a message. */
  readonly code: string
}

export interface MigrationJournal {
  readonly version: 1
  readonly migrationId: string
  readonly desktopVersion: string
  readonly state: JournalState
  /** One entry per step reached, in step order. */
  readonly steps: readonly JournalStep[]
  readonly failure?: MigrationFailure
  /** Counted failed automatic attempts per Desktop version; three stop the retries until Retry. */
  readonly attempts: Readonly<Record<string, number>>
  /** The service already ran lanes (N12): imports merge into its state. */
  readonly merge?: true
  /** The service's machine id, once `begin` learned it. */
  readonly machineId?: string
  /** The user pressed Retry after the attempts ran out or after a revert. */
  readonly retryRequested?: true
  readonly startedAt: string
  readonly updatedAt: string
}

const isStep = (v: unknown): v is MigrationStep => MIGRATION_STEPS.some((step) => step === v)
const isState = (v: unknown): v is JournalState => JOURNAL_STATES.some((state) => state === v)
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const code = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

function parseStep(v: unknown): JournalStep | null {
  if (!record(v) || !isStep(v.step) || (v.status !== 'pending' && v.status !== 'done')) return null
  if (!isIsoTime(v.at) || (v.digest !== undefined && !digest(v.digest))) return null
  return {
    step: v.step,
    status: v.status,
    ...(typeof v.digest === 'string' ? { digest: v.digest } : {}),
    at: v.at,
  }
}

function parseAttempts(v: unknown): Record<string, number> | null {
  if (!record(v)) return null
  const out: Record<string, number> = {}
  for (const [version, count] of Object.entries(v)) {
    if (version.length > 64 || typeof count !== 'number' || !Number.isInteger(count) || count < 0)
      return null
    out[version] = count
  }
  return out
}

/** A journal as written, or null when any field is not what this module writes. */
export function parseJournal(text: string): MigrationJournal | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!record(v) || v.version !== 1 || !isUuid(v.migrationId) || !isState(v.state)) return null
  if (typeof v.desktopVersion !== 'string' || v.desktopVersion.length > 64) return null
  if (!Array.isArray(v.steps) || !isIsoTime(v.startedAt) || !isIsoTime(v.updatedAt)) return null
  const steps = v.steps.map(parseStep)
  const attempts = parseAttempts(v.attempts)
  if (steps.some((s) => s === null) || !attempts) return null
  const failure = v.failure
  if (failure !== undefined && !(record(failure) && isStep(failure.step) && code(failure.code)))
    return null
  if (v.merge !== undefined && v.merge !== true) return null
  if (v.retryRequested !== undefined && v.retryRequested !== true) return null
  if (v.machineId !== undefined && typeof v.machineId !== 'string') return null
  return {
    version: 1,
    migrationId: v.migrationId,
    desktopVersion: v.desktopVersion,
    state: v.state,
    steps: steps as JournalStep[],
    ...(record(failure) ? { failure: failure as unknown as MigrationFailure } : {}),
    attempts,
    ...(v.merge ? { merge: true as const } : {}),
    ...(typeof v.machineId === 'string' ? { machineId: v.machineId } : {}),
    ...(v.retryRequested ? { retryRequested: true as const } : {}),
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
  }
}

export type JournalRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly journal: MigrationJournal }
  /** Present but not a journal this code wrote: the gate never treats it as "none". */
  | { readonly kind: 'unreadable' }

export function readJournal(dir: string): JournalRead {
  let text: string
  try {
    text = readFileSync(join(dir, JOURNAL_FILE), 'utf8')
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return { kind: 'none' }
    return { kind: 'unreadable' }
  }
  const journal = parseJournal(text)
  return journal ? { kind: 'ok', journal } : { kind: 'unreadable' }
}

/**
 * Whether this process may write a journal. A packaged app may. An unpackaged
 * build may only with both `PHOSPHOR_MIGRATE=1` and `PHOSPHOR_TEST_USER_DATA`,
 * so `npm run dev` and CI never migrate real userData (D1 §3.7, precondition 1).
 */
export type MigrationPermit =
  | { readonly allowed: true; readonly brand: 'migration-permit' }
  | { readonly allowed: false; readonly reason: string }

export const MIGRATE_ENV = 'PHOSPHOR_MIGRATE'

export function migrationPermit(input: {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}): MigrationPermit {
  if (input.isPackaged) return { allowed: true, brand: 'migration-permit' }
  if (input.env[MIGRATE_ENV] === '1' && input.env.PHOSPHOR_TEST_USER_DATA)
    return { allowed: true, brand: 'migration-permit' }
  return {
    allowed: false,
    reason: `Development builds migrate only with ${MIGRATE_ENV}=1 and PHOSPHOR_TEST_USER_DATA.`,
  }
}

export interface JournalWriter {
  readonly dir: string
  write(journal: MigrationJournal): void
}

/** The only way to write a journal; it needs an allowed permit. */
export function journalWriter(dir: string, permit: MigrationPermit): JournalWriter {
  if (!permit.allowed) throw new Error(permit.reason)
  return {
    dir,
    write(journal) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      atomicRecord(join(dir, JOURNAL_FILE), journal, 0o600)
    },
  }
}

export function newJournal(input: {
  migrationId: string
  desktopVersion: string
  at: string
  attempts?: Readonly<Record<string, number>>
  merge?: boolean
}): MigrationJournal {
  return {
    version: 1,
    migrationId: input.migrationId,
    desktopVersion: input.desktopVersion,
    state: 'running',
    steps: [],
    attempts: { ...input.attempts },
    ...(input.merge ? { merge: true as const } : {}),
    startedAt: input.at,
    updatedAt: input.at,
  }
}

/** `journal` with `step` recorded as `status`, replacing an earlier entry for the same step. */
export function withStep(
  journal: MigrationJournal,
  step: MigrationStep,
  status: JournalStep['status'],
  at: string,
  digest?: string,
): MigrationJournal {
  const entry: JournalStep = { step, status, at, ...(digest ? { digest } : {}) }
  const steps = [...journal.steps.filter((s) => s.step !== step), entry].sort(
    (a, b) => MIGRATION_STEPS.indexOf(a.step) - MIGRATION_STEPS.indexOf(b.step),
  )
  return { ...journal, steps, updatedAt: at }
}

export function withState(
  journal: MigrationJournal,
  state: JournalState,
  at: string,
  failure?: MigrationFailure,
): MigrationJournal {
  const { failure: _previous, ...rest } = journal
  return { ...rest, state, updatedAt: at, ...(failure ? { failure } : {}) }
}

export function stepEntry(journal: MigrationJournal, step: MigrationStep): JournalStep | undefined {
  return journal.steps.find((s) => s.step === step)
}

/** Whether `step` finished, with `digest` when one is given. */
export function stepDone(journal: MigrationJournal, step: MigrationStep, digest?: string): boolean {
  const entry = stepEntry(journal, step)
  return entry?.status === 'done' && (digest === undefined || entry.digest === digest)
}

/** At or past the commit point: the in-app runtime must never start. */
export function pastCommitPoint(state: JournalState): boolean {
  return state === 'commit-requested' || state === 'committed'
}
