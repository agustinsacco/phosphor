import { one, run, type Context } from '../database'
import type { BrainTidyStoredRun } from './types'

const states = ['idle', 'queued', 'sweeping', 'checking', 'failed', 'skipped', 'cancelled']
export function tidyRunState(ctx: Context): BrainTidyStoredRun {
  const row = one<BrainTidyStoredRun>(
    ctx,
    `SELECT state,done,total,found,error,model,started_at AS startedAt,finished_at AS finishedAt FROM tidy_run WHERE singleton=1`,
  )!
  return states.includes(row.state) ? row : { ...row, state: 'idle' }
}
export function saveTidyRunState(ctx: Context, value: BrainTidyStoredRun): void {
  if (
    !states.includes(value.state) ||
    [value.done, value.total, value.found].some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw new Error('Invalid Brain Tidy run.')
  run(
    ctx,
    'UPDATE tidy_run SET state=?,done=?,total=?,found=?,error=?,model=?,started_at=?,finished_at=? WHERE singleton=1',
    value.state,
    value.done,
    value.total,
    value.found,
    value.error,
    value.model,
    value.startedAt,
    value.finishedAt,
  )
}
