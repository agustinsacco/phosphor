import type { BrainTidyRun } from '@phosphor/shared/brain-tidy'
import { one, run, type Context } from '../database'

const states = ['queued', 'sweeping', 'checking', 'done', 'failed', 'cancelled']
/** The runtime owns interrupted-run recovery; the engine never starts or normalises a run. */
export function readRun(ctx: Context): BrainTidyRun | null {
  const row = one<BrainTidyRun>(
    ctx,
    `SELECT state,done AS checked,total,found AS suggestions,folded,error,message,started_at AS startedAt,finished_at AS finishedAt FROM tidy_run WHERE singleton=1`,
  )!
  return states.includes(row.state) ? row : null
}
export function writeRun(ctx: Context, value: BrainTidyRun): void {
  if (
    !states.includes(value.state) ||
    [value.checked, value.total, value.suggestions, value.folded, value.startedAt].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    (value.finishedAt !== null &&
      (!Number.isSafeInteger(value.finishedAt) || value.finishedAt < 0)) ||
    (value.error !== null && typeof value.error !== 'string') ||
    (value.message !== null && typeof value.message !== 'string')
  )
    throw new Error('Invalid Brain Tidy run.')
  run(
    ctx,
    'UPDATE tidy_run SET state=?,done=?,total=?,found=?,folded=?,error=?,message=?,started_at=?,finished_at=? WHERE singleton=1',
    value.state,
    value.checked,
    value.total,
    value.suggestions,
    value.folded,
    value.error,
    value.message,
    value.startedAt,
    value.finishedAt,
  )
}
