import type { BrainExtractionRecord, BrainExtractionOutcome } from '@phosphor/shared/brain'
import { scrubExcerpt } from './secrets'
import { all, one, run, type Context } from './database'

/** Hard expiry applies even to inbox jobs or referenced records. Never deletes knowledge. */
export function pruneExtractions(ctx: Context): void {
  run(
    ctx,
    `DELETE FROM extractions WHERE finished_at < ? OR (
    NOT EXISTS (SELECT 1 FROM memories WHERE memories.job_id=extractions.job_id) AND
    NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=extractions.job_id AND jobs.state!='done'))`,
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
    outcomes: JSON.parse(row.outcomes) as BrainExtractionOutcome[],
    memories: all(ctx, 'SELECT id, summary FROM memories WHERE job_id=?', jobId),
  }
}
/** Preserve the candidate-to-memory link even when only a subset was approved. */
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
