import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBenchmark, clusteredVector } from './benchmark-fixture'
import { openBrainSearch } from './search'
import { openBrainStore } from './store'
import { extraction, lane, vector } from './test-support'

it.skipIf(process.env.BRAIN_BENCH !== '1')(
  'reports synthetic Brain scale throughput',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'brain-benchmark-'))
    const path = join(directory, 'brain.sqlite')
    const store = openBrainStore({ path, Database: DatabaseSync })
    const search = openBrainSearch({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    try {
      const count = Number(process.env.BRAIN_BENCH_MEMORIES ?? 1_000_000)
      const entities = Math.max(100, Math.floor(count / 10))
      const start = performance.now()
      buildBenchmark(db, entities, count)
      const built = performance.now()
      search.refresh()
      const loaded = performance.now()
      const latencies: number[] = []
      for (let i = 0; i < 25; i++) {
        const at = performance.now()
        search.recall({
          query: `Ledger ${i + 1}`,
          vector: clusteredVector(i),
          limit: 8,
          scope: '/made-up/ledger',
          branch: null,
          now: Date.now(),
        })
        if (i >= 5) latencies.push(performance.now() - at)
      }
      const job = store.enqueue(lane(), 'queued')
      const data = extraction(job.id, { computedRevision: store.revision() })
      data.memories = Array.from({ length: 20 }, (_, i) => ({
        ...data.memories[0]!,
        summary: `Harbor review fact ${i}.`,
      }))
      data.memoryVectors = data.memories.map(() => vector())
      store.propose(data)
      const at = performance.now()
      store.review(
        job.id,
        { memories: data.memories.map((_, i) => i), identities: {}, groups: [] },
        store.revision(),
      )
      const reviewMs = performance.now() - at
      latencies.sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          entities,
          memories: count,
          buildMs: built - start,
          refreshMs: loaded - built,
          recallP50Ms: latencies[9],
          recallP95Ms: latencies[18],
          review20Ms: reviewMs,
          rssMiB: process.memoryUsage().rss / 1024 ** 2,
        }),
      )
      expect(store.snapshot().counts.memories).toBe(count + 20)
    } finally {
      search.close()
      store.close()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  600_000,
)
