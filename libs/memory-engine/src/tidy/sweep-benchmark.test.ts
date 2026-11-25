import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { buildBenchmark } from '../benchmark-fixture'
import { TIDY_CHUNK } from './sweep'

it('bounds and resumes a 5000-name bucket and a 60000-memory store without pairwise expansion', () => {
  const { store, db } = fixture()
  const buildStart = performance.now()
  buildBenchmark(db, 5000, 60000)
  db.exec(
    "UPDATE entities SET label='Rina Okafor',kind='person'; UPDATE entity_names SET name='Rina Okafor',folded='rina okafor'; UPDATE entity_words SET text='Rina Okafor'; UPDATE entity_grams SET name='Rina Okafor';",
  )
  const buildMs = performance.now() - buildStart
  const start = performance.now()
  const first = store.sweep('all')
  const firstMs = performance.now() - start
  expect(first.coverage).toMatchObject({
    phase: 'entities',
    entities: TIDY_CHUNK,
    memories: 0,
    totalEntities: 5000,
    totalMemories: 60000,
    cursor: TIDY_CHUNK,
  })
  expect(first.coverage.limitedChecks).toBeGreaterThan(0)
  expect(first.suggestions).toBeLessThanOrEqual(TIDY_CHUNK)
  expect(first.coverage.finishedAt).toBeNull()
  const second = store.sweep('all')
  expect(second.coverage.cursor).toBe(TIDY_CHUNK * 2)
  let chunk = second
  while (chunk.coverage.phase === 'entities') chunk = store.sweep('all')
  const memoryStart = performance.now()
  const memory = store.sweep('all')
  const memoryMs = performance.now() - memoryStart
  expect(memory.coverage).toMatchObject({
    phase: 'memories',
    entities: 5000,
    memories: TIDY_CHUNK,
    cursor: TIDY_CHUNK,
    finishedAt: null,
  })
  expect(memory.suggestions).toBeLessThanOrEqual(TIDY_CHUNK * 8)
  expect(memory.folded).toBe(0)
  expect(store.coverage().cursor).toBe(TIDY_CHUNK)
  expect(db.prepare('SELECT COUNT(*) AS n FROM tidy_suggestions').get()!.n).toBeLessThanOrEqual(
    5000 + TIDY_CHUNK * 8,
  )
  console.log(
    JSON.stringify({
      entities: 5000,
      memories: 60000,
      buildMs,
      firstEntityChunkMs: firstMs,
      allEntitiesMs: memoryStart - start,
      firstMemoryChunkMs: memoryMs,
      entitySuggestions: first.suggestions,
      memorySuggestions: memory.suggestions,
      coverage: memory.coverage,
    }),
  )
}, 600_000)
