import { fingerprintMemories } from './fingerprints'
import type { BrainTidyOperation } from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpRevision, revision } from '../prefs'
import { suppressPair } from './suggestions'
import { affected, rebuild } from './projections'
import {
  capture,
  currentRow,
  decodeImage,
  encodeImage,
  hash,
  knownTable,
  rowKey,
  rowKeys,
  type Image,
  type Row,
  type Rows,
  type RowTable,
  type Selection,
} from './rows'

export function checkRevision(ctx: Context, expected: number): void {
  if (expected !== revision(ctx)) throw new Error('Brain changed; refresh Tidy and try again.')
}
export interface JournalInput {
  kind: BrainTidyOperation['kind']
  subjects: { type: 'entity' | 'memory'; first: string; second: string }
  selection: Selection
  automatic?: boolean
  suggestionId?: string
}
/** Caller owns the transaction. Only changed source rows are retained, at most 200 operations. */
export function journal(ctx: Context, input: JournalInput, action: () => void): string {
  const before = capture(ctx, input.selection)
  const references = affected(before, new Map(), input.selection)
  const memories = all<{ id: string; n: number }>(
    ctx,
    'SELECT id,n FROM memories WHERE n IN (SELECT value FROM json_each(?))',
    JSON.stringify(references.memories),
  )
  action()
  const after = capture(ctx, input.selection)
  // A row can leave the selected neighbourhood without being deleted (shared evidence).
  for (const [table, rows] of before)
    for (const [key, row] of rows) {
      if (after.get(table)!.has(key)) continue
      const current = currentRow(ctx, table, row)
      if (current) after.get(table)!.set(key, current)
    }
  const id = ctx.id(),
    now = ctx.now()
  const summaries = {
    merge: 'Merged two people or things',
    fold: 'Folded two memories',
    dispute: 'Kept two memories as disputed',
    replace: 'Replaced one memory with another',
  }
  run(
    ctx,
    'INSERT INTO tidy_operations VALUES (?,?,?,?,?,?,?,?,?,?)',
    id,
    input.kind,
    input.automatic ? 1 : 0,
    summaries[input.kind],
    now,
    null,
    input.suggestionId ?? null,
    input.subjects.type,
    input.subjects.first,
    input.subjects.second,
  )
  saveDelta(ctx, id, before, after)
  for (const m of memories)
    run(ctx, 'INSERT INTO tidy_operation_memories VALUES (?,?,?)', id, m.id, m.n)
  run(
    ctx,
    'DELETE FROM tidy_operations WHERE id IN (SELECT id FROM tidy_operations ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 200)',
  )
  if (input.automatic)
    run(
      ctx,
      "INSERT INTO meta VALUES ('tidy_automatic_folds','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
    )
  return id
}
function saveDelta(ctx: Context, id: string, before: Rows, after: Rows): void {
  for (const table of Object.keys(rowKeys) as RowTable[]) {
    const old = before.get(table)!,
      next = after.get(table)!
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const previous = old.get(key) ?? null,
        current = next.get(key) ?? null
      if (hash(previous) === hash(current)) continue
      run(
        ctx,
        'INSERT INTO tidy_operation_rows VALUES (?,?,?,?,?)',
        id,
        table,
        key,
        encodeImage(table, previous ?? current!, previous),
        hash(current),
      )
    }
  }
}
interface Delta {
  table: RowTable
  image: Image
  current: Row | null
}
function undoRows(ctx: Context, id: string): Delta[] {
  return all<{ table_name: string; before_image: string; after_hash: string | null }>(
    ctx,
    'SELECT table_name,before_image,after_hash FROM tidy_operation_rows WHERE operation_id=?',
    id,
  ).map((row) => {
    if (!knownTable(row.table_name))
      throw new Error('This Brain change needs a newer application to undo.')
    const image = decodeImage(ctx, row.table_name, row.before_image)
    const current = currentRow(ctx, row.table_name, image.key)
    if (hash(current) !== row.after_hash)
      throw new Error('Later changes touch this Brain change; it cannot be cleanly undone.')
    return { table: row.table_name, image, current }
  })
}
function restore(ctx: Context, deltas: Delta[]): void {
  const order = Object.keys(rowKeys) as RowTable[]
  for (const table of [...order].reverse()) {
    for (const { image } of deltas.filter((d) => d.table === table && !d.image.row))
      run(
        ctx,
        `DELETE FROM ${table} WHERE ${rowKeys[table].map((k) => `${k}=?`).join(' AND ')}`,
        ...rowKeys[table].map((k) => image.key[k]!),
      )
  }
  for (const table of order) {
    for (const { image, current } of deltas.filter((d) => d.table === table && d.image.row)) {
      const row = image.row!,
        keys = Object.keys(row)
      if (current)
        run(
          ctx,
          `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${rowKeys[table].map((k) => `${k}=?`).join(' AND ')}`,
          ...keys.map((k) => row[k]!),
          ...rowKeys[table].map((k) => image.key[k]!),
        )
      else
        run(
          ctx,
          `INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          ...keys.map((k) => row[k]!),
        )
    }
  }
}
export function undo(ctx: Context, id: string, expected: number): Selection {
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    const op = one<{
      undone_at: number | null
      subject_type: 'entity' | 'memory'
      first_id: string
      second_id: string
      suggestion_id: string | null
    }>(ctx, 'SELECT * FROM tidy_operations WHERE id=?', id)
    if (!op) throw new Error('This Brain change is no longer available to undo.')
    if (op.undone_at !== null) throw new Error('This Brain change was already undone.')
    const deltas = undoRows(ctx, id)
    const selection = selectionOf(deltas)
    const names = deltas.filter((d) => d.table === 'entity_names').map((d) => Number(d.image.key.n))
    restore(ctx, deltas)
    rebuild(ctx, selection, names)
    fingerprintMemories(ctx, selection.memories)
    suppressPair(ctx, op.subject_type, op.first_id, op.second_id, op.suggestion_id)
    run(ctx, 'UPDATE tidy_operations SET undone_at=? WHERE id=?', ctx.now(), id)
    run(ctx, 'DELETE FROM tidy_operation_rows WHERE operation_id=?', id)
    run(ctx, 'DELETE FROM tidy_operation_memories WHERE operation_id=?', id)
    bumpRevision(ctx)
    return selection
  })
}
function selectionOf(deltas: Delta[]): Selection {
  const rows: Rows = new Map()
  for (const d of deltas)
    for (const row of [d.image.row, d.current]) {
      if (!row) continue
      if (!rows.has(d.table)) rows.set(d.table, new Map())
      rows.get(d.table)!.set(rowKey(d.table, row) + rows.get(d.table)!.size, row)
    }
  return affected(rows, new Map(), {
    entities: [...(rows.get('entities')?.values() ?? [])].map((r) => Number(r.n)),
    memories: [...(rows.get('memories')?.values() ?? [])].map((r) => Number(r.n)),
  })
}
