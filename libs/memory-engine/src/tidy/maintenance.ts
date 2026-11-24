import { all, one, run, type Context } from '../database'

/** Touched memories swept inside one mutation; the runtime sweeps the rest in batches this size. */
export const MAINTENANCE_BATCH = 128

interface Pending {
  generation: string
  ids: Set<string>
}
/** In memory only: if the app closes first, the missing fingerprints bring them into the next maintenance pass. */
const PENDING = new WeakMap<Context, Pending>()

function generation(ctx: Context): string {
  return one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='generation'")!.value
}
/**
 * Returns the first touched memories (in row order) to sweep now and keeps the rest pending.
 * The rest lose their fingerprints, so no exact-repeat check reads a key a merge made stale.
 */
export function deferMaintenance(ctx: Context, memoryIds: string[]): string[] {
  if (memoryIds.length <= MAINTENANCE_BATCH) return memoryIds
  const ordered = all<{ id: string; n: number }>(
    ctx,
    'SELECT id,n FROM memories WHERE id IN (SELECT value FROM json_each(?)) ORDER BY n',
    JSON.stringify(memoryIds),
  )
  const rest = ordered.slice(MAINTENANCE_BATCH)
  if (rest.length) {
    run(
      ctx,
      'DELETE FROM tidy_memory_keys WHERE memory IN (SELECT value FROM json_each(?))',
      JSON.stringify(rest.map((row) => row.n)),
    )
    const current = generation(ctx)
    let pending = PENDING.get(ctx)
    if (pending?.generation !== current) {
      pending = { generation: current, ids: new Set() }
      PENDING.set(ctx, pending)
    }
    for (const row of rest) pending.ids.add(row.id)
  }
  return ordered.slice(0, MAINTENANCE_BATCH).map((row) => row.id)
}
/** Hands over every pending id once; ids from before a reset are dropped. */
export function takeMaintenance(ctx: Context): string[] {
  const pending = PENDING.get(ctx)
  PENDING.delete(ctx)
  return pending && pending.generation === generation(ctx) ? [...pending.ids] : []
}
