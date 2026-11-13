import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { buildBenchmark, clusteredVector } from './benchmark-fixture'
import { cosine } from './vectors'
import { VectorIndex } from './vector-index'
import { fixture, searchFixture } from './test-support'

it('staged sign-bit candidates retain exact top ten on deterministic clustered fixtures', async () => {
  const { search, path } = searchFixture()
  const db = new DatabaseSync(path)
  try {
    const count = 2500
    buildBenchmark(db, 250, count)
    await search.refresh()
    const vectors = Array.from({ length: count }, (_, i) => clusteredVector(i + 1))
    for (const index of [1, 37, 129, 991, 2301]) {
      const query = clusteredVector(index)
      const exact = vectors
        .map((v, i) => ({ id: `memory-${i + 1}`, score: cosine(query, v) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 10)
      const actual = search.nearestMemories([query], 10)[0]!
      expect(
        actual.filter((item) => exact.some((row) => row.id === item.id)).length / 10,
      ).toBeGreaterThanOrEqual(0.95)
    }
  } finally {
    db.close()
  }
})

it('reranks a shortlist with one indexed vector read, in primary-key order', async () => {
  const { db } = fixture()
  buildBenchmark(db, 250, 2500)
  const ctx = { db, now: () => 1, id: () => 'unused' }
  const index = (await new VectorIndex(ctx, 'memory').refresh(true, () => true))!
  const calls: unknown[][] = []
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!sql.includes('memory_vectors')) return statement
    const all = statement.all.bind(statement)
    const get = statement.get.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...args) => {
      calls.push(args)
      return all(...args)
    })
    vi.spyOn(statement, 'get').mockImplementation((...args) => {
      calls.push(args)
      return get(...args)
    })
    return statement
  })
  expect(index.nearest(clusteredVector(37), 10)).toHaveLength(10)
  expect(calls).toHaveLength(1)
  const numbers = JSON.parse(calls[0]![0] as string) as number[]
  expect(numbers).toEqual(numbers.toSorted((a, b) => a - b))
})
