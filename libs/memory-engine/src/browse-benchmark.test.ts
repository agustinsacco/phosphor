import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBenchmark } from './benchmark-fixture'
import { openBrainStore } from './store'
import { entities, recent } from './browse'
import { lane } from './test-support'
import type { Context } from './database'

it.skipIf(process.env.BRAIN_BROWSE_BENCH !== '1')(
  'measures v5 browse reads on the synthetic million-memory fixture',
  () => {
    const directory = mkdtempSync(join(process.cwd(), '.brain-browse-bench-'))
    const path = join(directory, 'brain.sqlite')
    const store = openBrainStore({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    const ctx: Context = { db, now: Date.now, id: () => 'synthetic' }
    try {
      const count = Number(process.env.BRAIN_BENCH_MEMORIES ?? 1_000_000)
      const entityCount = Math.max(100, Math.floor(count / 10))
      const start = performance.now()
      buildBenchmark(db, entityCount, count)
      db.exec(`UPDATE entities SET kind='event' WHERE n=${entityCount}`)
      for (let i = 0; i < 20; i++) {
        const job = store.enqueue(lane({ sessionId: `ledger-read-${i}` }), 'queued')
        store.updateJob(job.id, { state: 'done', finishedAt: 1000 + i })
        db.prepare('UPDATE memories SET job_id=? WHERE n>? AND n<=?').run(
          job.id,
          i * 50,
          (i + 1) * 50,
        )
      }
      const built = performance.now()
      const measure = (read: () => unknown): number => {
        const at = performance.now()
        read()
        return performance.now() - at
      }
      const timings = JSON.stringify({
        entities: entityCount,
        memories: count,
        buildMs: built - start,
        allMs: measure(() => entities(ctx, null, 0, 20)),
        commonKindMs: measure(() => entities(ctx, 'project', 0, 20)),
        rareKindMs: measure(() => entities(ctx, 'event', 0, 20)),
        kindsMs: measure(() =>
          db.prepare('SELECT DISTINCT kind FROM entities WHERE memories>0').all(),
        ),
        recentMs: measure(() => recent(ctx, 10)),
      })
      // Keep measured evidence even when a runner hides successful-test console output.
      writeFileSync(join(process.cwd(), '.brain-browse-benchmark.json'), timings + '\n')
      console.log(timings)
      expect(entities(ctx, 'event', 0, 20).items).toHaveLength(1)
      expect(recent(ctx, 10).items).toHaveLength(10)
    } finally {
      db.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  600_000,
)
