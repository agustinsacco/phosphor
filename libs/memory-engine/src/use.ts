/**
 * How memories get used: recall hits shown to lanes and flags filed against them. Shown to Brain
 * Agent to spot stale or doubted memories; never used to rank, and never a revision change.
 */
import { run, transaction, type Context } from './database'

export function recordRecall(ctx: Context, memoryIds: string[], at: number): void {
  if (!memoryIds.length) return
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid Brain recall time.')
  transaction(ctx, () =>
    run(
      ctx,
      `INSERT INTO memory_use(memory,recalled,last_recalled)
      SELECT n,1,? FROM memories WHERE id IN (SELECT DISTINCT value FROM json_each(?))
      ON CONFLICT(memory) DO UPDATE SET recalled=recalled+1,last_recalled=MAX(COALESCE(last_recalled,0),excluded.last_recalled)`,
      at,
      JSON.stringify(memoryIds),
    ),
  )
}
/** Caller owns the transaction: a flag filed against the memory. */
export function recordFlag(ctx: Context, memoryId: string): void {
  run(
    ctx,
    `INSERT INTO memory_use(memory,flagged) SELECT n,1 FROM memories WHERE id=?
    ON CONFLICT(memory) DO UPDATE SET flagged=flagged+1`,
    memoryId,
  )
}
