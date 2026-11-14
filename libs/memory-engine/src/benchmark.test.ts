import { DatabaseSync } from 'node:sqlite'
import { constants, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildBenchmark, clusteredVector } from './benchmark-fixture'
import { openBrainSearch } from './search'
import { openBrainStore } from './store'
import { extraction, lane, vector } from './test-support'
import type { BrainSearch } from './types'

async function measureLoad(search: BrainSearch) {
  let done = false
  let worstYieldMs = 0
  let worstLexicalMs = 0
  let ticks = 0
  const monitor = async () => {
    while (!done) {
      const at = performance.now()
      await setImmediate()
      worstYieldMs = Math.max(worstYieldMs, performance.now() - at)
      if (!done && ticks++ % 20 === 0) {
        const start = performance.now()
        expect(search.find('Ledger 7', null, 5).degradation).not.toEqual([])
        worstLexicalMs = Math.max(worstLexicalMs, performance.now() - start)
      }
    }
  }
  await Promise.all([
    search.refresh().finally(() => {
      done = true
    }),
    monitor(),
  ])
  return { worstYieldMs, worstLexicalMs }
}

function measureQueries(search: BrainSearch) {
  const recall: number[] = []
  const find: number[] = []
  for (let i = 0; i < 25; i++) {
    const query = `Ledger ${i + 1}`
    const vector = clusteredVector(i)
    const at = performance.now()
    search.recall({
      query,
      vector,
      limit: 8,
      scope: '/made-up/ledger',
      branch: null,
      now: Date.now(),
    })
    if (i >= 5) recall.push(performance.now() - at)
    const findAt = performance.now()
    search.find(query, vector, 10)
    if (i >= 5) find.push(performance.now() - findAt)
  }
  recall.sort((a, b) => a - b)
  find.sort((a, b) => a - b)
  return {
    recallP50Ms: recall[9],
    recallP95Ms: recall[18],
    findP50Ms: find[9],
    findP95Ms: find[18],
  }
}

it.skipIf(process.env.BRAIN_BENCH !== '1')(
  'reports synthetic Brain scale throughput',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brain-benchmark-'))
    const path = join(directory, 'brain.sqlite')
    // Optional synthetic fixture is copied, never opened writable in place.
    if (process.env.BRAIN_BENCH_SOURCE)
      copyFileSync(process.env.BRAIN_BENCH_SOURCE, path, constants.COPYFILE_FICLONE)
    const store = openBrainStore({ path, Database: DatabaseSync })
    const search = openBrainSearch({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    try {
      const count = Number(process.env.BRAIN_BENCH_MEMORIES ?? 1_000_000)
      const entities = Math.max(100, Math.floor(count / 10))
      const start = performance.now()
      if (!process.env.BRAIN_BENCH_SOURCE) buildBenchmark(db, entities, count)
      const built = performance.now()
      const responsiveness = await measureLoad(search)
      const loaded = performance.now()
      const timings = measureQueries(search)
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
      console.log(
        JSON.stringify({
          entities,
          memories: count,
          buildMs: built - start,
          refreshMs: loaded - built,
          ...timings,
          ...responsiveness,
          loadAverage: loadavg(),
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
