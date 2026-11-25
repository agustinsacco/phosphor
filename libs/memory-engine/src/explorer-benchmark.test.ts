import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBenchmark } from './benchmark-fixture'
import { openBrainStore } from './store'

/**
 * Entity 1 is the fixture's hub: half of all links point to it. Every other entity states its
 * links several times over, so grouping by neighbour matters on every page.
 */
it.skipIf(process.env.BRAIN_EXPLORER_BENCH !== '1')(
  'measures grouped connections and entity views on the synthetic million-memory fixture',
  () => {
    const directory = mkdtempSync(join(process.cwd(), '.brain-explorer-bench-'))
    const path = join(directory, 'brain.sqlite')
    const store = openBrainStore({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    try {
      const count = Number(process.env.BRAIN_BENCH_MEMORIES ?? 1_000_000)
      const entities = Math.max(100, Math.floor(count / 10))
      buildBenchmark(db, entities, count)
      // A real Brain file is checkpointed; reading through a fresh 5 GB WAL measures the build.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const deep = (id: string, pages: number) => () => {
        let next: string | null = null
        for (let i = 0; i < pages; i++) next = store.connections(id, 'part_of', 'in', next).next
      }
      const timings = {
        entities,
        memories: count,
        hubEntityMs: time(() => store.entity('entity-1')),
        hubFirstPageMs: time(() => store.connections('entity-1', 'part_of', 'in', null)),
        hubTenPagesMs: time(deep('entity-1', 10)),
        leafEntityMs: time(() => store.entity('entity-1234')),
        leafIntoHubMs: time(() => store.connections('entity-1234', 'part_of', 'out', null)),
        rowPagedBeforeMs: time(() => rowPage(db, 1)),
        rowTotalBeforeMs: time(() => rowTotal(db, 1)),
        neighbourhoodHubMs: time(() => store.neighbourhood('entity-1', 2, 300)),
      }
      writeFileSync(join(process.cwd(), '.brain-explorer-benchmark.json'), JSON.stringify(timings))
      console.log(JSON.stringify(timings))
      const leaf = store.connections('entity-1234', 'part_of', 'out', null)
      expect(leaf.items).toHaveLength(1)
      expect(leaf.items[0]).toMatchObject({ entity: { id: 'entity-1' }, supports: 10 })
      // The hub's one parent and its incoming project and person neighbours.
      const groups = store.entity('entity-1').groups
      expect(groups.map((g) => [g.predicate, g.direction, g.items.length])).toEqual([
        ['works_on', 'in', 8],
        ['part_of', 'out', 1],
        ['part_of', 'in', 8],
      ])
      expect(groups[0]!.items[0]!.supports).toBe(10)
    } finally {
      db.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  900_000,
)

function time(read: () => unknown): { first: number; again: number } {
  const run = () => {
    const start = performance.now()
    read()
    return performance.now() - start
  }
  return { first: run(), again: run() }
}
/** The pre-grouping page and total, for comparison on the same file. */
function rowPage(db: DatabaseSync, n: number): unknown {
  return db
    .prepare(
      "SELECT r.n,r.observed_at FROM relations r WHERE r.object=? AND r.live=1 AND r.predicate='part_of' ORDER BY r.observed_at DESC,r.n DESC LIMIT 41",
    )
    .all(n)
}
function rowTotal(db: DatabaseSync, n: number): unknown {
  return db
    .prepare(
      "SELECT COUNT(*) AS total FROM relations WHERE object=? AND live=1 AND predicate='part_of'",
    )
    .get(n)
}
