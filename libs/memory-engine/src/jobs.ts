import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { pruneExtractions } from './extractions'
import { prefs } from './prefs'
import type { JobPart, JobPatch, NewJob } from './types'

const columns = `id, session_id AS sessionId, session_path AS sessionPath, title, scope, branch,
 model, state, memories, leaf_id AS leafId, error, queued_at AS queuedAt,
 started_at AS startedAt, finished_at AS finishedAt, usage, progress, replaces,
 from_leaf AS fromLeafId, run_started_at AS runStartedAt`
type JobRow = Omit<BrainJob, 'usage' | 'progress'> & {
  usage: string | null
  progress: string | null
}
/** An untitled lane's title stays '': the app names it, and no title rule can match it. */
function decode(row: JobRow): BrainJob {
  return {
    ...row,
    progress: row.progress ? (JSON.parse(row.progress) as BrainJob['progress']) : null,
    usage: row.usage ? (JSON.parse(row.usage) as BrainJob['usage']) : null,
  }
}
export function job(ctx: Context, id: string): BrainJob | undefined {
  const row = one<JobRow>(ctx, `SELECT ${columns} FROM jobs WHERE id=?`, id)
  return row && decode(row)
}
export function jobs(ctx: Context): BrainJob[] {
  return all<JobRow>(
    ctx,
    `SELECT ${columns} FROM jobs WHERE state NOT IN ('done','rejected') ORDER BY queued_at, rowid`,
  ).map(decode)
}
export function finishedJobs(ctx: Context, limit: number): BrainJob[] {
  return all<JobRow>(
    ctx,
    `SELECT ${columns} FROM jobs WHERE state IN ('done','empty','rejected')
    ORDER BY finished_at DESC, queued_at DESC, rowid DESC LIMIT ?`,
    limit,
  ).map(decode)
}
function save(ctx: Context, value: BrainJob): void {
  run(
    ctx,
    `INSERT INTO jobs VALUES (${Array(21).fill('?').join(',')})`,
    value.id,
    value.sessionId,
    value.sessionPath,
    value.title,
    value.scope,
    value.branch,
    value.model,
    value.state,
    value.memories,
    value.leafId,
    value.error,
    value.queuedAt,
    value.startedAt,
    value.finishedAt,
    value.usage ? JSON.stringify(value.usage) : null,
    BRAIN_EXTRACTOR_VERSION,
    value.progress ? JSON.stringify(value.progress) : null,
    null,
    value.replaces,
    value.fromLeafId,
    value.runStartedAt,
  )
}
export const BRAIN_EXTRACTOR_VERSION = 6

export function enqueue(ctx: Context, value: NewJob, state: 'waiting' | 'queued'): BrainJob {
  return transaction(ctx, () => {
    const refusal = brainNeverReadReason(prefs(ctx).neverRead, value)
    if (refusal) throw new Error(refusal)
    if (value.replaces) {
      const previous = job(ctx, value.replaces)
      if (previous?.state !== 'done')
        throw new Error('Only finished Brain reads can be read again.')
      if (previous.sessionId !== value.sessionId)
        throw new Error('This read belongs to a different lane.')
    }
    const unfinished = one(
      ctx,
      `SELECT id FROM jobs WHERE session_id=? AND state IN
      ('waiting','queued','running','refreshing','review')`,
      value.sessionId,
    )
    if (unfinished) throw new Error('This lane is already queued.')
    const last = one<{ leaf_id: string | null }>(
      ctx,
      "SELECT leaf_id FROM jobs WHERE session_id=? AND state IN ('done','empty','rejected') ORDER BY queued_at DESC, rowid DESC LIMIT 1",
      value.sessionId,
    )
    if (!value.replaces && last && last.leaf_id === value.leafId) {
      throw new Error('Nothing new in this lane since its last read.')
    }
    const result: BrainJob = {
      ...value,
      replaces: value.replaces ?? null,
      id: ctx.id(),
      state,
      memories: 0,
      error: null,
      queuedAt: ctx.now(),
      startedAt: null,
      runStartedAt: null,
      fromLeafId: value.replaces ? null : (last?.leaf_id ?? null),
      finishedAt: null,
      usage: null,
      progress: null,
    }
    // Agent decisions defer retention so undo stays exact; the next enqueue pays that debt.
    pruneFinishedReads(ctx, value.sessionId)
    save(ctx, result)
    return result
  })
}
export function updateJob(ctx: Context, id: string, patch: JobPatch, prune = true): BrainJob {
  const existing = job(ctx, id)
  if (!existing) throw new Error('Brain job not found.')
  if (
    ['leafId', 'model', 'branch'].some((key) => {
      const field = key as 'leafId' | 'model' | 'branch'
      return patch[field] !== undefined && patch[field] !== existing[field]
    })
  )
    throw new Error('Brain job metadata is frozen outside its first prepare checkpoint.')
  if (
    existing.startedAt !== null &&
    patch.startedAt !== undefined &&
    patch.startedAt !== existing.startedAt
  )
    throw new Error('The first read start cannot change.')
  const updated = { ...existing, ...patch }
  if (['done', 'empty', 'rejected'].includes(updated.state) && updated.finishedAt === null)
    updated.finishedAt = ctx.now()
  if (updated.state !== 'running' && updated.state !== 'refreshing') updated.runStartedAt = null
  // Updating columns rather than REPLACE preserves proposal foreign keys.
  run(
    ctx,
    `UPDATE jobs SET state=?, error=?, started_at=?, finished_at=?, usage=?, memories=?,
      leaf_id=?, model=?, branch=?, progress=?, run_started_at=?, title=? WHERE id=?`,
    updated.state,
    updated.error,
    updated.startedAt,
    updated.finishedAt,
    updated.usage ? JSON.stringify(updated.usage) : null,
    updated.memories,
    updated.leafId,
    updated.model,
    updated.branch,
    updated.progress ? JSON.stringify(updated.progress) : null,
    updated.runStartedAt,
    updated.title,
    id,
  )
  if (prune && ['done', 'empty', 'rejected'].includes(updated.state)) {
    pruneFinishedReads(ctx, updated.sessionId)
    pruneExtractions(ctx)
  }
  return updated
}
/** Finished jobs and their source records share the same per-lane cap, even with live memories. */
function pruneFinishedReads(ctx: Context, sessionId: string): void {
  const displaced = `SELECT id FROM jobs WHERE session_id=? AND state IN ('done','empty','rejected')
    ORDER BY finished_at DESC, queued_at DESC, rowid DESC LIMIT -1 OFFSET 20`
  run(ctx, `DELETE FROM extractions WHERE job_id IN (${displaced})`, sessionId)
  run(ctx, `DELETE FROM jobs WHERE id IN (${displaced})`, sessionId)
}

export function removeJob(ctx: Context, id: string): void {
  run(ctx, 'DELETE FROM jobs WHERE id=?', id)
  pruneExtractions(ctx)
}
export function requeueInterrupted(ctx: Context): void {
  transaction(ctx, () => {
    run(
      ctx,
      "UPDATE jobs SET state='queued', run_started_at=NULL, finished_at=NULL, error=NULL WHERE state='running'",
    )
    run(ctx, "UPDATE jobs SET run_started_at=NULL, error=NULL WHERE state='refreshing'")
  })
}

export function retry(ctx: Context, id: string): BrainJob {
  const current = job(ctx, id)
  if (current?.state !== 'failed') throw new Error('Only failed Brain jobs can be retried.')
  if (hasLaterRead(ctx, id))
    throw new Error('A later read of this lane already covers these messages.')
  return updateJob(ctx, id, { state: 'queued', error: null, finishedAt: null, progress: null })
}
/** Queue order, including tied timestamps, defines which read covers a lane's later messages. */
export function hasLaterRead(ctx: Context, id: string): boolean {
  return !!one(
    ctx,
    `SELECT 1 FROM jobs later JOIN jobs current ON later.session_id=current.session_id
      WHERE current.id=? AND (later.queued_at > current.queued_at OR
      (later.queued_at = current.queued_at AND later.rowid > current.rowid)) LIMIT 1`,
    id,
  )
}
export function part(
  ctx: Context,
  jobId: string,
  name: string,
  inputHash?: string,
): JobPart | undefined {
  return one(
    ctx,
    `SELECT part,input_hash AS inputHash,output FROM job_parts
     WHERE job_id=? AND part=? AND state='done'${inputHash === undefined ? '' : ' AND input_hash=?'} LIMIT 1`,
    jobId,
    name,
    ...(inputHash === undefined ? [] : [inputHash]),
  )
}
export function savePart(ctx: Context, jobId: string, value: JobPart): void {
  transaction(ctx, () => {
    const saved = part(ctx, jobId, 'prepare', 'frozen-v4')
    if (value.part === 'prepare') {
      if (value.inputHash !== 'frozen-v4' || !value.prepare)
        throw new Error('Brain prepare metadata is required.')
      if (saved) {
        if (
          saved.output !== value.output ||
          Object.entries(value.prepare).some(
            ([key, v]) => job(ctx, jobId)?.[key as keyof BrainJob] !== v,
          )
        )
          throw new Error('Brain job metadata is frozen.')
        return
      }
      if (!job(ctx, jobId)) throw new Error('Brain job not found.')
      run(
        ctx,
        'UPDATE jobs SET leaf_id=?,model=?,branch=?,from_leaf=? WHERE id=?',
        value.prepare.leafId,
        value.prepare.model,
        value.prepare.branch,
        value.prepare.fromLeafId === undefined
          ? job(ctx, jobId)!.fromLeafId
          : value.prepare.fromLeafId,
        jobId,
      )
    } else if (value.prepare) throw new Error('Only prepare can freeze Brain job metadata.')
    run(
      ctx,
      "INSERT OR REPLACE INTO job_parts VALUES (?,?,?,'done',?)",
      jobId,
      value.part,
      value.inputHash,
      value.output,
    )
  })
}
