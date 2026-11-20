import { redactAgentReasons } from '../agent/text-privacy'
import { all, one, run, type Context } from '../database'
import { currentRow, decodeImage, knownTable } from './rows'
import { flagKeyPrefix } from './flag-keys'

/** Forget runs this before deleting live rows, while changed relation keys can still be resolved. */
export function eraseTidyMemory(ctx: Context, id: string, n: number): void {
  eraseSuggestions(ctx, id)
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
  redactAgentReasons(ctx, forgotten[0]!)
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
    const evidence = forgottenEvidence(ctx, rows, n, relations)
    for (const row of rows) {
      if (!knownTable(row.table_name)) {
        eraseBeforeImages(ctx, op.id)
        break
      }
      const image = decodeImage(ctx, row.table_name, row.before_image)
      const value = image.row ?? currentRow(ctx, row.table_name, image.key) ?? image.key
      if (
        (row.table_name === 'evidence' && evidence.has(Number(value.n))) ||
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
  eraseEntityText(ctx, forgotten)
}

/**
 * A description or name an edit or merge replaced can quote the forgotten memory even when the
 * operation never touched it. Read undo records can hold the same text in a whole proposal.
 */
function eraseEntityText(ctx: Context, forgotten: string[]): void {
  const rows = all<{ id: string; table_name: string; before_image: string }>(
    ctx,
    `SELECT r.operation_id AS id,r.table_name,r.before_image FROM tidy_operation_rows r
      JOIN tidy_operations o ON o.id=r.operation_id
      WHERE r.table_name IN ('entities','entity_names','merges','proposals','extractions')`,
  )
  const holds = (row: (typeof rows)[number]): boolean => {
    try {
      return retainedText(ctx, row, forgotten)
    } catch {
      return true // An unreadable record cannot prove it is safe; Forget must still finish.
    }
  }
  for (const id of new Set(rows.filter(holds).map((row) => row.id))) eraseBeforeImages(ctx, id)
}

/** Suggestions about the memory, and lane flags filed against it wherever a fold moved them. */
function eraseSuggestions(ctx: Context, id: string): void {
  run(
    ctx,
    "DELETE FROM tidy_suggestions WHERE subject_type='memory' AND (first_id=? OR second_id=?)",
    id,
    id,
  )
  // A flag keeps the flagged memory in its key wherever a fold has moved it.
  const prefix = flagKeyPrefix(id)
  run(
    ctx,
    'DELETE FROM tidy_suggestions WHERE pair_key>=? AND pair_key<?',
    prefix,
    `${prefix.slice(0, -1)}/`,
  )
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
  // aliases and read snapshots can quote a forgotten sentence, making the whole undo unsafe.
  if (
    !['entities', 'entity_names', 'merges', 'proposals', 'extractions'].includes(value.table_name)
  )
    return false
  // Proposal payloads and extraction calls/outcomes hold their text inside a JSON string.
  const phrases = forgotten.flatMap((phrase) => [phrase, JSON.stringify(phrase).slice(1, -1)])
  return Object.values(image.row ?? {}).some(
    (text) => typeof text === 'string' && phrases.some((phrase) => text.includes(phrase)),
  )
}

function forgottenEvidence(
  ctx: Context,
  rows: { table_name: string; before_image: string }[],
  n: number,
  relations: Set<number>,
): Set<number> {
  const evidence = new Set<number>()
  for (const row of rows) {
    if (row.table_name !== 'citations' && row.table_name !== 'relation_support') continue
    const image = decodeImage(ctx, row.table_name, row.before_image)
    const value = image.row ?? image.key
    if (value.memory === n || relations.has(Number(value.relation)))
      evidence.add(Number(value.evidence))
  }
  return evidence
}
