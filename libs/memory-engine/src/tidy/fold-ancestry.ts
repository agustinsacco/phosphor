import { one, run, type Context } from '../database'

/** References outlive intervening folds, including their undo and journal retention. */
export function inheritFoldReferences(ctx: Context, source: string, target: string): void {
  run(
    ctx,
    `INSERT OR IGNORE INTO tidy_operation_memories
      SELECT operation_id, m.id, m.n FROM tidy_operation_memories a JOIN memories m ON m.id=?
      WHERE a.memory_id=?`,
    target,
    source,
  )
}

/** Keep pair suppression but never strand forgotten text on a removed subject. */
export function settleFoldSuggestions(ctx: Context, source: string, target: string): void {
  const flag = one<{ id: string; session_id: string }>(
    ctx,
    "SELECT id,session_id FROM tidy_suggestions WHERE subject_type='memory' AND first_id=? AND kind='flagged' AND state='open'",
    source,
  )
  if (flag) {
    const key = `flag:${Buffer.from(target).toString('hex')}.${Buffer.from(flag.session_id).toString('hex')}`
    if (
      !one(
        ctx,
        "SELECT 1 FROM tidy_suggestions WHERE pair_key=? OR (subject_type='memory' AND first_id=? AND kind='flagged' AND state='open')",
        key,
        target,
      )
    )
      run(ctx, 'UPDATE tidy_suggestions SET first_id=?,pair_key=? WHERE id=?', target, key, flag.id)
  }
  run(
    ctx,
    `UPDATE tidy_suggestions SET reason='One of these was folded into another memory.',
      verdict_reason=NULL,title=CASE WHEN kind='flagged' THEN '' ELSE title END
      WHERE subject_type='memory' AND (first_id=? OR second_id=?)`,
    source,
    source,
  )
}
