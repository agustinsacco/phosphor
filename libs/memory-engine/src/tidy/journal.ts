import { cleanNote, saveNote, pruneOperations, type JournalNote } from '../agent/notes'
import { checkCreatedDependents } from '../agent/undo-reads'
import { hasLaterRead } from '../jobs'
import {
  captureMemoryGuards,
  checkDependents,
  checkSplitDependents,
  foldGuards,
  mergeGuards,
  restoreLinkedStates,
  rewrittenBy,
  type Delta,
  type Guards,
} from './undo-guards'
import { inheritFoldReferences, movedFlagTable, returnMovedFlags } from './fold-ancestry'
import { scrubExcerpt } from '../secrets'
import { fingerprintMemories } from './fingerprints'
import type { BrainTidyOperation } from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpKnowledgeRevision, bumpRevision, revision } from '../prefs'
import { suppressPair } from './suggestions'
import { affected, rebuild } from './projections'
import {
  capture,
  currentRow,
  decodeImage,
  encodeGuard,
  encodeImage,
  hash,
  knownTable,
  rowKey,
  rowKeys,
  type Rows,
  type RowTable,
  type Selection,
} from './rows'

const LATER_CHANGES = 'Later changes touch this Brain change; it cannot be cleanly undone.'
export function checkRevision(ctx: Context, expected: number): void {
  if (expected !== revision(ctx)) throw new Error('Brain changed; refresh Tidy and try again.')
}
export interface JournalInput {
  kind: BrainTidyOperation['kind']
  /** A split learns its second subject, the record it creates, inside the action. */
  subjects: { type: 'entity' | 'memory'; first: string; second: string }
  /** The action may add to it (a split adds the record it creates) before the after-capture. */
  selection: Selection
  /** Tables the change can touch; an entity edit need not read a hub's every mention. */
  only?: ReadonlySet<RowTable>
  /** The Recent changes line; defaults to the kind's generic wording. */
  summary?: string
  automatic?: boolean
  suggestionId?: string
  note?: JournalNote
  id?: string
}
const SUMMARIES: Record<BrainTidyOperation['kind'], string> = {
  merge: 'Merged two people or things',
  fold: 'Folded two memories',
  dispute: 'Kept two memories as disputed',
  replace: 'Replaced one memory with another',
  split: 'Split one record into two',
  unname: 'Removed a name from a record',
  describe: 'Changed a description',
  approve: 'Approved a read',
  reject: 'Rejected a read',
  keep: 'Kept both as they are',
  correct: 'Corrected a memory',
  erase: 'Erased a memory',
}
/** Operations that settle a pair; undoing one keeps the pair apart. */
const PAIR_KINDS = new Set(['merge', 'fold', 'dispute', 'replace'])
/** Caller owns the transaction. The latest run and recent erasures outlive the 200-row cap. */
export function journal(ctx: Context, input: JournalInput, action: () => void): string {
  if (input.note) input.note = cleanNote(input.note)
  const read = input.kind === 'approve' || input.kind === 'reject'
  const before = capture(ctx, input.selection, input.only, read)
  const references = affected(before, new Map(), input.selection)
  const memories = all<{ id: string; n: number }>(
    ctx,
    'SELECT id,n FROM memories WHERE n IN (SELECT value FROM json_each(?))',
    JSON.stringify(references.memories),
  )
  const guards = journalGuards(ctx, input, before, references.memories)
  if (guards) captureMemoryGuards(ctx, before, guards.memories)
  action()
  const after = capture(
    ctx,
    guards
      ? {
          ...input.selection,
          memories: [...new Set([...input.selection.memories, ...guards.memories])],
        }
      : input.selection,
    input.only,
    read,
  )
  // A row can leave the selected neighbourhood without being deleted (shared evidence).
  for (const [table, rows] of before)
    for (const [key, row] of rows) {
      if (after.get(table)!.has(key)) continue
      const current = currentRow(ctx, table, row)
      if (current) after.get(table)!.set(key, current)
    }
  const id = input.id ?? ctx.id(),
    now = ctx.now()
  run(
    ctx,
    'INSERT INTO tidy_operations VALUES (?,?,?,?,?,?,?,?,?,?)',
    id,
    input.kind,
    input.automatic ? 1 : 0,
    scrubExcerpt(input.summary ?? SUMMARIES[input.kind])
      .replace(/\s+/gu, ' ')
      .slice(0, 300),
    now,
    null,
    input.suggestionId ?? null,
    input.subjects.type,
    input.subjects.first,
    input.subjects.second,
  )
  if (input.note) saveNote(ctx, id, 'made', input.note)
  saveDelta(ctx, id, before, after, guards)
  const recorded = new Map(memories.map((m) => [m.id, m]))
  for (const row of after.get('memories')!.values())
    recorded.set(String(row.id), { id: String(row.id), n: Number(row.n) })
  for (const m of recorded.values())
    run(ctx, 'INSERT INTO tidy_operation_memories VALUES (?,?,?)', id, m.id, m.n)
  if (input.kind === 'fold') inheritFoldReferences(ctx, input.subjects.first, input.subjects.second)
  pruneOperations(ctx)
  if (input.automatic)
    run(
      ctx,
      "INSERT INTO meta VALUES ('tidy_automatic_folds','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
    )
  return id
}
function journalGuards(
  ctx: Context,
  input: JournalInput,
  before: Rows,
  memories: number[],
): Guards | null {
  if (input.kind === 'approve' || input.kind === 'reject')
    return {
      memories,
      covers: (table) => table === 'jobs',
    }
  if (input.kind === 'fold') return foldGuards(memories)
  if (input.kind !== 'merge') return null
  const [source, survivor] = [input.subjects.first, input.subjects.second].map(
    (id) => one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', id)!.n,
  )
  return mergeGuards(rewrittenBy(before, source!), survivor!)
}
/** A changed row keeps its before-image; an unchanged guarded row keeps only its key and hash. */
function saveDelta(ctx: Context, id: string, before: Rows, after: Rows, guards: Guards | null) {
  for (const table of Object.keys(rowKeys) as RowTable[]) {
    const old = before.get(table)!,
      next = after.get(table)!
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const previous = old.get(key) ?? null,
        current = next.get(key) ?? null
      const unchanged = hash(previous) === hash(current)
      if (unchanged && !guards?.covers(table, current!)) continue
      run(
        ctx,
        'INSERT INTO tidy_operation_rows VALUES (?,?,?,?,?)',
        id,
        table,
        key,
        unchanged
          ? encodeGuard(table, current!)
          : encodeImage(table, previous ?? current!, previous),
        hash(current),
      )
    }
  }
}
function undoGuards(ctx: Context, kind: string, survivorId: string, deltas: Delta[]): Guards {
  const memories = new Set<number>()
  for (const d of deltas)
    if (d.table === 'mentions' || d.table === 'relations')
      memories.add(Number((d.image.row ?? d.current ?? d.image.key).memory))
  if (kind === 'fold') return foldGuards(selectionOf(deltas).memories)
  const survivor = one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', survivorId)
  if (!survivor) throw new Error(LATER_CHANGES)
  return mergeGuards([...memories], survivor.n)
}
function undoRows(ctx: Context, id: string): Delta[] {
  return all<{ table_name: string; before_image: string; after_hash: string | null }>(
    ctx,
    'SELECT table_name,before_image,after_hash FROM tidy_operation_rows WHERE operation_id=? AND table_name!=?',
    id,
    movedFlagTable,
  ).map((row) => {
    if (!knownTable(row.table_name))
      throw new Error('This Brain change needs a newer application to undo.')
    const image = decodeImage(ctx, row.table_name, row.before_image)
    const current = currentRow(ctx, row.table_name, image.key)
    if (hash(current) !== row.after_hash) throw new Error(LATER_CHANGES)
    return { table: row.table_name, image, current }
  })
}
function restore(ctx: Context, deltas: Delta[]): void {
  const order = Object.keys(rowKeys) as RowTable[]
  const remove = (table: RowTable) => {
    for (const { image } of deltas.filter(
      (d) => d.table === table && !d.image.row && !d.image.guard,
    ))
      run(
        ctx,
        `DELETE FROM ${table} WHERE ${rowKeys[table].map((k) => `${k}=?`).join(' AND ')}`,
        ...rowKeys[table].map((k) => image.key[k]!),
      )
  }
  // A record a split created goes last, once no restored mention or link names it.
  for (const table of [...order].reverse()) if (table !== 'entities') remove(table)
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
  remove('entities')
}
export function undo(ctx: Context, id: string, expected: number, note?: JournalNote): Selection {
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    if (note) note = cleanNote(note)
    const op = one<{
      kind: string
      undone_at: number | null
      subject_type: 'entity' | 'memory'
      first_id: string
      second_id: string
      suggestion_id: string | null
    }>(ctx, 'SELECT * FROM tidy_operations WHERE id=?', id)
    if (!op) throw new Error('This Brain change is no longer available to undo.')
    if (op.undone_at !== null) throw new Error('This Brain change was already undone.')
    if (op.kind === 'erase') throw new Error("Erasing can't be undone.")
    if (['approve', 'reject'].includes(op.kind) && hasLaterRead(ctx, op.first_id))
      throw new Error(LATER_CHANGES)
    const deltas = undoRows(ctx, id)
    if (!deltas.length && op.kind !== 'keep')
      throw new Error(
        'This Brain change is no longer available to undo because a memory was forgotten.',
      )
    const selection = selectionOf(deltas)
    if (op.kind === 'approve' || op.kind === 'correct') checkCreatedDependents(ctx, deltas)
    if (op.kind === 'keep') {
      const suggestion = one<{ state: string }>(
        ctx,
        'SELECT state FROM tidy_suggestions WHERE id=?',
        op.suggestion_id,
      )
      if (suggestion?.state !== 'dismissed') throw new Error(LATER_CHANGES)
      run(
        ctx,
        "UPDATE tidy_suggestions SET state='open',updated_at=? WHERE id=?",
        ctx.now(),
        op.suggestion_id,
      )
    }
    if (op.kind === 'merge' || op.kind === 'fold')
      checkDependents(ctx, deltas, undoGuards(ctx, op.kind, op.second_id, deltas))
    if (op.kind === 'split') checkSplitDependents(ctx, deltas, op.first_id, op.second_id)
    const names = deltas.filter((d) => d.table === 'entity_names').map((d) => Number(d.image.key.n))
    try {
      restore(ctx, deltas)
    } catch {
      // A constraint a later change introduced; the transaction rolls back untouched.
      throw new Error(LATER_CHANGES)
    }
    if (op.kind === 'fold') returnMovedFlags(ctx, id, op.second_id)
    restoreLinkedStates(ctx, selection.memories)
    rebuild(ctx, selection, names)
    fingerprintMemories(ctx, selection.memories)
    if (PAIR_KINDS.has(op.kind))
      suppressPair(ctx, op.subject_type, op.first_id, op.second_id, op.suggestion_id)
    if (note) saveNote(ctx, id, 'undid', note)
    run(ctx, 'UPDATE tidy_operations SET undone_at=? WHERE id=?', ctx.now(), id)
    run(ctx, 'DELETE FROM tidy_operation_rows WHERE operation_id=?', id)
    run(ctx, 'DELETE FROM tidy_operation_memories WHERE operation_id=?', id)
    if (op.kind === 'reject' || op.kind === 'keep') bumpRevision(ctx)
    else bumpKnowledgeRevision(ctx)
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
    entities: [
      ...[...(rows.get('entities')?.values() ?? [])].map((r) => Number(r.n)),
      // A removed name's record needs its words and trigrams rebuilt too.
      ...[...(rows.get('entity_names')?.values() ?? [])].map((r) => Number(r.entity)),
    ],
    memories: [
      ...[...(rows.get('memories')?.values() ?? [])].map((r) => Number(r.n)),
      ...[...(rows.get('memory_links')?.values() ?? [])].flatMap((r) => [
        Number(r.source),
        Number(r.target),
      ]),
    ],
  })
}
