import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { buildBenchmark, clusteredVector } from './benchmark-fixture'
import { cosine } from './vectors'
import { searchFixture } from './test-support'

it('staged sign-bit candidates retain exact top ten on deterministic clustered fixtures', () => {
  const { search, path } = searchFixture()
  const db = new DatabaseSync(path)
  try {
    const count = 2500
    buildBenchmark(db, 250, count)
    search.refresh()
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
