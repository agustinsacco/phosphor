import { all, run, type Context } from '../database'
import { capture, rowKey, type Image, type Row, type Rows, type RowTable } from './rows'

export interface Delta {
  table: RowTable
  image: Image
  current: Row | null
}
/**
 * Which unchanged rows an operation guards, by key and hash only. A fold guards its memories'
 * neighbourhood, so later quotes on them refuse the undo. A merge guards only what depends on it:
 * on the memories whose mentions or relations it rewrote, the rows naming the survivor and the
 * memory links. Vectors are never guards; undo never rewrites a row it did not change.
 */
export interface Guards {
  memories: number[]
  covers: (table: RowTable, row: Row) => boolean
}
const foldTables = new Set<RowTable>([
  'memories',
  'mentions',
  'relations',
  'relation_support',
  'citations',
  'evidence',
  'memory_links',
])
export function foldGuards(memories: number[]): Guards {
  return { memories, covers: (table) => foldTables.has(table) }
}
export function mergeGuards(memories: number[], survivor: number): Guards {
  const rewritten = new Set(memories)
  return {
    memories,
    covers: (table, row) =>
      table === 'memory_links' ||
      (rewritten.has(Number(row.memory)) &&
        ((table === 'mentions' && row.entity === survivor) ||
          (table === 'relations' && (row.subject === survivor || row.object === survivor)))),
  }
}
/** The memories whose mentions or relations a merge of `source` rewrites. */
export function rewrittenBy(before: Rows, source: number): number[] {
  const memories = new Set<number>()
  for (const row of before.get('mentions')!.values())
    if (row.entity === source) memories.add(Number(row.memory))
  for (const row of before.get('relations')!.values())
    if (row.subject === source || row.object === source) memories.add(Number(row.memory))
  return [...memories]
}
/** Unchanged dependent rows are guards too: a later INSERT can leave every parent hash intact. */
export function captureMemoryGuards(ctx: Context, before: Rows, memories: number[]): void {
  for (const [table, rows] of capture(ctx, { entities: [], memories }))
    for (const [key, row] of rows) before.get(table)!.set(key, row)
}
export function checkDependents(ctx: Context, deltas: Delta[], guards: Guards): void {
  const known = new Map<RowTable, Set<string>>()
  for (const delta of deltas) {
    if (!known.has(delta.table)) known.set(delta.table, new Set())
    known.get(delta.table)!.add(rowKey(delta.table, delta.image.key))
  }
  for (const [table, rows] of capture(ctx, { entities: [], memories: guards.memories }))
    for (const [key, row] of rows)
      if (guards.covers(table, row) && !known.get(table)?.has(key))
        throw new Error('Later changes touch this Brain change; it cannot be cleanly undone.')
}

/** State is a projection of the surviving history, not of one operation's before-image. */
export function restoreLinkedStates(ctx: Context, memories: number[]): void {
  for (const n of memories) {
    const links = all<{ kind: string; target: number }>(
      ctx,
      'SELECT kind,target FROM memory_links WHERE source=? OR target=?',
      n,
      n,
    )
    const superseded = links.some(
      (l) => l.target === n && ['supersedes', 'resolves'].includes(l.kind),
    )
    const disputed = links.some((l) => l.kind === 'conflicts')
    if (superseded || disputed)
      run(ctx, 'UPDATE memories SET state=? WHERE n=?', superseded ? 'superseded' : 'disputed', n)
    else run(ctx, "UPDATE memories SET state='active' WHERE n=? AND state='disputed'", n)
    run(
      ctx,
      "UPDATE relations SET live=(SELECT state!='superseded' FROM memories WHERE n=?) WHERE memory=?",
      n,
      n,
    )
  }
}
