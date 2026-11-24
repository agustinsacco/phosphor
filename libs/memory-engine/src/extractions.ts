import type { BrainExtractionRecord, BrainExtractionOutcome } from '@phosphor/shared/brain'
import { scrubExcerpt } from './secrets'
import { all, one, run, type Context } from './database'

/** Jobs retain records without expiry; orphaned records need memories and expire after 30 days. */
export function pruneExtractions(ctx: Context): void {
  run(
    ctx,
    `DELETE FROM extractions WHERE
    NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=extractions.job_id) AND
    (finished_at < ? OR NOT EXISTS (SELECT 1 FROM memories WHERE memories.job_id=extractions.job_id))`,
    ctx.now() - 30 * 86_400_000,
  )
}
export function saveExtraction(ctx: Context, record: BrainExtractionRecord): void {
  run(
    ctx,
    `INSERT OR REPLACE INTO extractions VALUES (${Array(12).fill('?').join(',')})`,
    record.jobId,
    record.sessionId,
    record.sessionPath,
    scrubExcerpt(record.title),
    record.leafId,
    record.model,
    record.thinking,
    JSON.stringify(
      record.calls.map((call) => ({
        ...call,
        answer: scrubExcerpt(call.answer),
        error: call.error && scrubExcerpt(call.error),
      })),
    ),
    JSON.stringify(
      record.outcomes.map((outcome) => ({
        ...outcome,
        summary: scrubExcerpt(outcome.summary),
        reason: outcome.reason && scrubExcerpt(outcome.reason),
      })),
    ),
    record.error && scrubExcerpt(record.error),
    record.startedAt,
    record.finishedAt,
  )
  pruneExtractions(ctx)
}
export function extraction(
  ctx: Context,
  jobId: string,
): BrainExtractionRecord & {
  memories: { id: string; summary: string }[]
} {
  const row = one<
    Omit<BrainExtractionRecord, 'calls' | 'outcomes'> & { calls: string; outcomes: string }
  >(
    ctx,
    `SELECT job_id AS jobId, session_id AS sessionId, session_path AS sessionPath, title,
     leaf_id AS leafId, model, thinking, calls, outcomes, error,
     started_at AS startedAt, finished_at AS finishedAt FROM extractions WHERE job_id=?`,
    jobId,
  )
  if (!row) throw new Error('Brain extraction not found (dismissed or expired).')
  return {
    ...row,
    calls: JSON.parse(row.calls) as BrainExtractionRecord['calls'],
    outcomes: (JSON.parse(row.outcomes) as BrainExtractionOutcome[]).map((outcome) => ({
      ...outcome,
      ...(outcome.memoryId && !one(ctx, 'SELECT 1 FROM memories WHERE id=?', outcome.memoryId)
        ? { removed: true }
        : {}),
    })),
    memories: all(ctx, 'SELECT id, summary FROM memories WHERE job_id=?', jobId),
  }
}
/** Links a read's claim to the memory it saved as, so the read record can name it. */
export function linkOutcome(
  ctx: Context,
  jobId: string,
  proposalIndex: number,
  memoryId: string,
): void {
  const row = one<{ outcomes: string }>(
    ctx,
    'SELECT outcomes FROM extractions WHERE job_id=?',
    jobId,
  )
  if (!row) return
  const outcomes = JSON.parse(row.outcomes) as BrainExtractionOutcome[]
  for (const outcome of outcomes) {
    if (outcome.proposalIndex === proposalIndex) outcome.memoryId = memoryId
  }
  run(ctx, 'UPDATE extractions SET outcomes=? WHERE job_id=?', JSON.stringify(outcomes), jobId)
}
