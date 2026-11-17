import { all, one, run, type Context } from '../database'
import { currentRow, decodeImage, knownTable } from './rows'

/** Forget runs this before deleting live rows, while changed relation keys can still be resolved. */
export function eraseTidyMemory(ctx: Context, id: string, n: number): void {
  run(
    ctx,
    "DELETE FROM tidy_suggestions WHERE subject_type='memory' AND (first_id=? OR second_id=?)",
    id,
    id,
  )
  const ops = all<{ id: string; kind: string }>(
    ctx,
    'SELECT o.id,o.kind FROM tidy_operation_memories m JOIN tidy_operations o ON o.id=m.operation_id WHERE m.memory_id=?',
    id,
  )
  const forgotten = [
    one<{ summary: string }>(ctx, 'SELECT summary FROM memories WHERE n=?', n)!.summary,
    ...all<{ quote: string }>(ctx, 'SELECT quote FROM citations WHERE memory=?', n).map(
      (r) => r.quote,
    ),
  ].filter(Boolean)
  for (const op of ops) {
    if (
      op.kind !== 'merge' ||
      one(
        ctx,
        `SELECT 1 FROM tidy_operation_memories r WHERE r.operation_id=?
          AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=r.memory_id)`,
        op.id,
      )
    ) {
      eraseBeforeImages(ctx, op.id)
      continue
    }
    const rows = all<{ table_name: string; row_key: string; before_image: string }>(
      ctx,
      'SELECT table_name,row_key,before_image FROM tidy_operation_rows WHERE operation_id=?',
      op.id,
    )
    if (rows.some((row) => retainedText(ctx, row, forgotten))) {
      eraseBeforeImages(ctx, op.id)
      continue
    }
    const relations = new Set(
      all<{ n: number }>(ctx, 'SELECT n FROM relations WHERE memory=?', n).map((r) => r.n),
    )
    for (const row of rows) {
      if (row.table_name !== 'relations') continue
      const image = decodeImage(ctx, 'relations', row.before_image)
      if (image.row?.memory === n) relations.add(Number(image.key.n))
    }
    for (const row of rows) {
      if (!knownTable(row.table_name)) {
        eraseBeforeImages(ctx, op.id)
        break
      }
      const image = decodeImage(ctx, row.table_name, row.before_image)
      const value = image.row ?? currentRow(ctx, row.table_name, image.key) ?? image.key
      if (
        value.memory === n ||
        (row.table_name === 'memories' && value.n === n) ||
        (row.table_name === 'memory_links' && (value.source === n || value.target === n)) ||
        (row.table_name === 'relation_support' && relations.has(Number(value.relation)))
      )
        run(
          ctx,
          'DELETE FROM tidy_operation_rows WHERE operation_id=? AND table_name=? AND row_key=?',
          op.id,
          row.table_name,
          row.row_key,
        )
    }
    run(ctx, 'DELETE FROM tidy_operation_memories WHERE operation_id=? AND memory_id=?', op.id, id)
  }
}

function eraseBeforeImages(ctx: Context, id: string): void {
  run(ctx, 'DELETE FROM tidy_operation_rows WHERE operation_id=?', id)
  run(ctx, 'DELETE FROM tidy_operation_memories WHERE operation_id=?', id)
}
function retainedText(
  ctx: Context,
  value: { table_name: string; before_image: string },
  forgotten: string[],
): boolean {
  if (!knownTable(value.table_name)) return true
  const image = decodeImage(ctx, value.table_name, value.before_image)
  // Other rows are redacted by their memory/relation identity below. Entity descriptions and
  // aliases can themselves quote a forgotten sentence, making the whole undo unsafe to keep.
  if (!['entities', 'entity_names', 'merges'].includes(value.table_name)) return false
  return Object.values(image.row ?? {}).some(
    (text) => typeof text === 'string' && forgotten.some((phrase) => text.includes(phrase)),
  )
}
