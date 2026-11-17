import { all, run, type Context } from '../database'
import { capture, rowKey, type Image, type Row, type Rows, type RowTable } from './rows'

export interface Delta {
  table: RowTable
  image: Image
  current: Row | null
}
const memoryTables = new Set<RowTable>([
  'memories',
  'mentions',
  'relations',
  'relation_support',
  'citations',
  'evidence',
  'memory_links',
  'memory_vectors',
])
export function memoryGuard(table: RowTable): boolean {
  return memoryTables.has(table)
}
/** Unchanged dependent rows are guards too: a later INSERT can leave every parent hash intact. */
export function captureMemoryGuards(ctx: Context, before: Rows, memories: number[]): void {
  for (const [table, rows] of capture(ctx, { entities: [], memories }))
    for (const [key, row] of rows) before.get(table)!.set(key, row)
}
export function checkDependents(ctx: Context, deltas: Delta[], memories: number[]): void {
  const known = new Map<RowTable, Set<string>>()
  for (const delta of deltas) {
    if (!known.has(delta.table)) known.set(delta.table, new Set())
    known.get(delta.table)!.add(rowKey(delta.table, delta.image.key))
  }
  for (const [table, rows] of capture(ctx, { entities: [], memories }))
    for (const key of rows.keys())
      if (!known.get(table)?.has(key))
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
