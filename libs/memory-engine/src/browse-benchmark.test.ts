import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBenchmark } from './benchmark-fixture'
import { openBrainStore } from './store'
import { entities } from './browse'
import type { Context } from './database'

it.skipIf(process.env.BRAIN_BROWSE_BENCH !== '1')(
  'measures v5 browse reads on the synthetic million-memory fixture',
  () => {
    const directory = mkdtempSync(join(process.cwd(), '.brain-browse-bench-'))
    const path = join(directory, 'brain.sqlite')
    const store = openBrainStore({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    try {
      const count = Number(process.env.BRAIN_BENCH_MEMORIES ?? 1_000_000)
      const entityCount = Math.max(100, Math.floor(count / 10))
      const start = performance.now()
      buildBenchmark(db, entityCount, count)
      db.exec(`UPDATE entities SET kind='event' WHERE n=${entityCount}`)
      const built = performance.now()
      const timings = JSON.stringify({
        entities: entityCount,
        memories: count,
        buildMs: built - start,
        allMs: measure(path, (ctx) => entities(ctx, null, 0, 20, 'connected')),
        deepPageMs: measure(path, (ctx) => entities(ctx, null, 2000, 20, 'connected')),
        commonKindMs: measure(path, (ctx) => entities(ctx, 'project', 0, 20, 'connected')),
        rareKindMs: measure(path, (ctx) => entities(ctx, 'event', 0, 20, 'connected')),
        recentSortMs: measure(path, (ctx) => entities(ctx, null, 0, 20, 'recent')),
        recentDeepMs: measure(path, (ctx) => entities(ctx, null, 2000, 20, 'recent')),
        nameSortMs: measure(path, (ctx) => entities(ctx, null, 0, 20, 'name')),
        nameKindMs: measure(path, (ctx) => entities(ctx, 'project', 0, 20, 'name')),
        kindsMs: measure(path, (ctx) =>
          ctx.db.prepare('SELECT DISTINCT kind FROM entities WHERE memories>0').all(),
        ),
      })
      // Keep measured evidence even when a runner hides successful-test console output.
      writeFileSync(join(process.cwd(), '.brain-browse-benchmark.json'), timings + '\n')
      console.log(timings)
      const ctx: Context = { db, now: Date.now, id: () => 'synthetic' }
      expect(entities(ctx, 'event', 0, 20, 'connected').items).toHaveLength(1)
    } finally {
      db.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  600_000,
)

/** Each operation starts on a fresh SQLite page cache; OS disk caching is not controlled. */
function measure(path: string, read: (ctx: Context) => unknown): { cold: number; warm: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  const ctx: Context = { db, now: Date.now, id: () => 'synthetic' }
  const run = (): number => {
    const start = performance.now()
    read(ctx)
    return performance.now() - start
  }
  try {
    return { cold: run(), warm: run() }
  } finally {
    db.close()
  }
}
