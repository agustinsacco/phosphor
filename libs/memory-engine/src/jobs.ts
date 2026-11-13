import type { BrainJob } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { pruneExtractions } from './extractions'
import type { JobPart, JobPatch, NewJob } from './types'

const columns = `id, session_id AS sessionId, session_path AS sessionPath, title, scope, branch,
 model, state, memories, leaf_id AS leafId, error, queued_at AS queuedAt,
 started_at AS startedAt, finished_at AS finishedAt, usage, progress`
type JobRow = Omit<BrainJob, 'usage' | 'progress'> & {
  usage: string | null
  progress: string | null
}
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
    `SELECT ${columns} FROM jobs WHERE state!='done' ORDER BY queued_at, rowid`,
  ).map(decode)
}
function save(ctx: Context, value: BrainJob): void {
  run(
    ctx,
    `INSERT INTO jobs VALUES (${Array(18).fill('?').join(',')})`,
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
  )
}
export const BRAIN_EXTRACTOR_VERSION = 4

export function enqueue(ctx: Context, value: NewJob, state: 'waiting' | 'queued'): BrainJob {
  return transaction(ctx, () => {
    const unfinished = one(
      ctx,
      `SELECT id FROM jobs WHERE session_id=? AND state IN
      ('waiting','queued','running','review')`,
      value.sessionId,
    )
    if (unfinished) throw new Error('This lane is already queued.')
    const last = one<{ leaf_id: string | null }>(
      ctx,
      "SELECT leaf_id FROM jobs WHERE session_id=? AND state IN ('done','empty') AND extractor=? ORDER BY queued_at DESC LIMIT 1",
      value.sessionId,
      BRAIN_EXTRACTOR_VERSION,
    )
    if (last && last.leaf_id === value.leafId) {
      throw new Error('Nothing new in this lane since its last extraction.')
    }
    const result: BrainJob = {
      ...value,
      id: ctx.id(),
      state,
      memories: 0,
      error: null,
      queuedAt: ctx.now(),
      startedAt: null,
      finishedAt: null,
      usage: null,
      progress: null,
    }
    save(ctx, result)
    return result
  })
}
export function updateJob(ctx: Context, id: string, patch: JobPatch): BrainJob {
  const existing = job(ctx, id)
  if (!existing) throw new Error('Brain job not found.')
  if (
    ['leafId', 'model', 'branch'].some((key) => {
      const field = key as 'leafId' | 'model' | 'branch'
      return patch[field] !== undefined && patch[field] !== existing[field]
    })
  )
    throw new Error('Brain job metadata is frozen outside its first prepare checkpoint.')
  const updated = { ...existing, ...patch }
  // Updating columns rather than REPLACE preserves proposal foreign keys.
  run(
    ctx,
    `UPDATE jobs SET state=?, error=?, started_at=?, finished_at=?, usage=?, memories=?,
      leaf_id=?, model=?, branch=?, progress=? WHERE id=?`,
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
    id,
  )
  if (updated.state === 'done') {
    run(
      ctx,
      "DELETE FROM jobs WHERE session_id=? AND state='done' AND id!=?",
      updated.sessionId,
      id,
    )
    pruneExtractions(ctx)
  }
  return updated
}
export function removeJob(ctx: Context, id: string): void {
  run(ctx, 'DELETE FROM jobs WHERE id=?', id)
  pruneExtractions(ctx)
}
export function requeueInterrupted(ctx: Context): void {
  run(ctx, "UPDATE jobs SET state='queued', finished_at=NULL, error=NULL WHERE state='running'")
}

export function retry(ctx: Context, id: string): BrainJob {
  if (job(ctx, id)?.state !== 'failed') throw new Error('Only failed Brain jobs can be retried.')
  return updateJob(ctx, id, { state: 'queued', error: null, finishedAt: null, progress: null })
}
export function part(
  ctx: Context,
  jobId: string,
  name: string,
  inputHash: string,
): JobPart | undefined {
  return one(
    ctx,
    "SELECT part,input_hash AS inputHash,output FROM job_parts WHERE job_id=? AND part=? AND input_hash=? AND state='done'",
    jobId,
    name,
    inputHash,
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
        'UPDATE jobs SET leaf_id=?,model=?,branch=? WHERE id=?',
        value.prepare.leafId,
        value.prepare.model,
        value.prepare.branch,
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
