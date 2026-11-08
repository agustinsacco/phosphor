import type { BrainJob } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import type { JobPatch, NewJob } from './types'

const columns = `id, session_id AS sessionId, session_path AS sessionPath, title, scope, branch,
 model, state, memories, leaf_id AS leafId, error, queued_at AS queuedAt,
 started_at AS startedAt, finished_at AS finishedAt, usage`
type JobRow = Omit<BrainJob, 'usage'> & { usage: string | null }
function decode(row: JobRow): BrainJob {
  return { ...row, usage: row.usage ? (JSON.parse(row.usage) as BrainJob['usage']) : null }
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
    `INSERT OR REPLACE INTO jobs VALUES (${Array(15).fill('?').join(',')})`,
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
  )
}
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
      "SELECT leaf_id FROM jobs WHERE session_id=? AND state='done'",
      value.sessionId,
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
    }
    save(ctx, result)
    return result
  })
}
export function updateJob(ctx: Context, id: string, patch: JobPatch): BrainJob {
  const existing = job(ctx, id)
  if (!existing) throw new Error('Brain job not found.')
  const updated = { ...existing, ...patch }
  // Updating columns rather than REPLACE preserves proposal foreign keys.
  run(
    ctx,
    `UPDATE jobs SET state=?, error=?, started_at=?, finished_at=?, usage=?, memories=?,
      leaf_id=?, model=?, branch=? WHERE id=?`,
    updated.state,
    updated.error,
    updated.startedAt,
    updated.finishedAt,
    updated.usage ? JSON.stringify(updated.usage) : null,
    updated.memories,
    updated.leafId,
    updated.model,
    updated.branch,
    id,
  )
  if (updated.state === 'done') {
    run(
      ctx,
      "DELETE FROM jobs WHERE session_id=? AND state='done' AND id!=?",
      updated.sessionId,
      id,
    )
  }
  return updated
}
export function removeJob(ctx: Context, id: string): void {
  run(ctx, 'DELETE FROM jobs WHERE id=?', id)
}
export function requeueInterrupted(ctx: Context): void {
  run(
    ctx,
    "UPDATE jobs SET state='queued', started_at=NULL, finished_at=NULL, error=NULL WHERE state='running'",
  )
}
