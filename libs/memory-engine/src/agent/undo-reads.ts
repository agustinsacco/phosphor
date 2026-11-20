import { type Context } from '../database'
import { capture, rowKey, type RowTable } from '../tidy/rows'
import type { Delta } from '../tidy/undo-guards'

/** Deleting a created record must not cascade away a later read's contributions. */
export function checkCreatedDependents(ctx: Context, deltas: Delta[]): void {
  const created = (table: RowTable) =>
    deltas
      .filter((d) => d.table === table && !d.image.row && !d.image.guard)
      .map((d) => Number(d.image.key.n))
  const known = new Map<RowTable, Set<string>>()
  for (const d of deltas) {
    if (!known.has(d.table)) known.set(d.table, new Set())
    known.get(d.table)!.add(rowKey(d.table, d.image.key))
  }
  const entities = created('entities'),
    memories = created('memories')
  for (const [table, rows] of capture(ctx, { entities, memories }))
    for (const key of rows.keys())
      if (!known.get(table)?.has(key))
        throw new Error('Later changes touch this Brain change; it cannot be cleanly undone.')
}
