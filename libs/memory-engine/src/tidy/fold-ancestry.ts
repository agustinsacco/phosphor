import { all, one, run, type Context } from '../database'
import { flagKey } from './flag-keys'

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

/** Journal rows that record a lane flag a fold moved; undo reads them, never restores them. */
export const movedFlagTable = 'tidy_suggestions'
/** Keep pair suppression but never strand forgotten text on a removed subject. */
export function settleFoldSuggestions(
  ctx: Context,
  operation: string,
  source: string,
  target: string,
): void {
  const flag = one<{ id: string; session_id: string }>(
    ctx,
    "SELECT id,session_id FROM tidy_suggestions WHERE subject_type='memory' AND first_id=? AND kind='flagged' AND state='open'",
    source,
  )
  if (
    flag &&
    !one(
      ctx,
      "SELECT 1 FROM tidy_suggestions WHERE pair_key=? OR (subject_type='memory' AND first_id=? AND kind='flagged' AND state='open')",
      flagKey(target, flag.session_id),
      target,
    )
  ) {
    run(ctx, 'UPDATE tidy_suggestions SET first_id=? WHERE id=?', target, flag.id)
    run(
      ctx,
      'INSERT INTO tidy_operation_rows VALUES (?,?,?,?,NULL)',
      operation,
      movedFlagTable,
      Buffer.from(flag.id).toString('hex'),
      JSON.stringify({ version: 1, key: { id: flag.id }, row: { first_id: source } }),
    )
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
/** An undone fold puts each flag it moved back on the memory the lane flagged. */
export function returnMovedFlags(ctx: Context, operation: string, target: string): void {
  for (const row of all<{ before_image: string }>(
    ctx,
    'SELECT before_image FROM tidy_operation_rows WHERE operation_id=? AND table_name=?',
    operation,
    movedFlagTable,
  )) {
    const image = JSON.parse(row.before_image) as {
      key?: { id?: unknown }
      row?: { first_id?: unknown }
    }
    const id = image.key?.id,
      source = image.row?.first_id
    if (typeof id !== 'string' || typeof source !== 'string')
      throw new Error('This Brain change has an unreadable undo record.')
    run(
      ctx,
      "UPDATE tidy_suggestions SET first_id=? WHERE id=? AND kind='flagged' AND first_id=?",
      source,
      id,
      target,
    )
  }
}
