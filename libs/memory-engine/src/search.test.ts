import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { approve, extraction, searchFixture, vector } from './test-support'
import { freshness } from './recall'
import { named } from './seeds'

it('degrades during initial loading, then recalls paraphrases through vectors with no evidence text', () => {
  const { store, search } = searchFixture()
  approve(store)
  expect(search.ready()).toBe(false)
  const input = {
    query: 'network resilience',
    vector: vector(),
    limit: 8,
    scope: null,
    branch: null,
    now: Date.now(),
  }
  expect(search.recall(input).degradation).toEqual([
    'Semantic index loading; words and names only.',
  ])
  search.refresh()
  const result = search.recall(input)
  expect(search.ready()).toBe(true)
  expect(result.hits[0]?.reasons).toContain('semantic')
  expect(result.degradation).toEqual([])
  expect(JSON.stringify(result)).not.toContain('Rina owns Harbor.')
})
it('loads incrementally, filters deletions and clears all old rows on reset generation', () => {
  const { store, search } = searchFixture()
  const ids = approve(store)
  search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.forget(ids[0]!)
  search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(1)
  const next = extraction('next')
  approve(store, { jobId: 'next', memories: [next.memories[0]!], memoryVectors: [vector()] })
  search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.reset()
  search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toEqual([])
  expect(search.find('Harbor', vector(), 20).entities).toEqual([])
})
it('find returns entities and memories with referenced entity cards and bounded limits', () => {
  const { store, search } = searchFixture()
  approve(store)
  const result = search.find('Rina', null, 10)
  expect(result.entities[0]?.label).toBe('Rina Okafor')
  expect(result.memories[0]?.summary).toContain('Rina')
  expect(result.referenced.map((item) => item.label)).toContain('Harbor')
  expect(search.find('Rina', null, 0).memories).toEqual([])
})
it('keeps named matching whole-word, unicode-folded and punctuation-aware', () => {
  const entities = ['C++', 'C#', 'C framework', 'Harbor billing', 'Harborview'].map((label) => ({
    id: label,
    label,
    aliases: [],
    kind: 'concept' as const,
    description: '',
  }))
  expect(named(entities, 'C++').map((item) => item.label)).toEqual(['C++'])
  expect(named(entities, '"C#"?').map((item) => item.label)).toEqual(['C#'])
  expect(named(entities, ' ＨＡＲＢＯＲ ').map((item) => item.label)).toEqual(['Harbor billing'])
  expect(named(entities, 'the')).toEqual([])
})
it('freshness ignores future effective dates and retains old memories', () => {
  const { store } = searchFixture()
  const [id] = approve(store)
  const memory = { ...store.memory(id!).memory, type: 'fact' as const, observedAt: 0 }
  const now = 200 * 86_400_000
  expect(freshness({ ...memory, validFrom: 180 * 86_400_000 }, now)).toBeCloseTo(
    0.5 + 0.5 * 2 ** (-20 / 180),
  )
  expect(freshness({ ...memory, validFrom: now + 1 }, now)).toBe(
    freshness({ ...memory, validFrom: null }, now),
  )
})

it('refresh reads maintained counts instead of scanning all bit rows', () => {
  const { store, search, path } = searchFixture()
  approve(store)
  search.refresh()
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare("SELECT value FROM meta WHERE key='entity_bits'").get()).toEqual({
      value: '3',
    })
    expect(db.prepare("SELECT value FROM meta WHERE key='memory_bits'").get()).toEqual({
      value: '2',
    })
  } finally {
    db.close()
  }
})
