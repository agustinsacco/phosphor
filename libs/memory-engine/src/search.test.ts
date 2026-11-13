import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { VectorIndex } from './vector-index'
import { approve, extraction, searchFixture, vector } from './test-support'
import { freshness } from './recall'
import { named } from './seeds'

it('degrades during initial loading, then recalls paraphrases through vectors with no evidence text', async () => {
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
  await search.refresh()
  const result = search.recall(input)
  expect(search.ready()).toBe(true)
  expect(result.hits[0]?.reasons).toContain('semantic')
  expect(result.degradation).toEqual([])
  expect(JSON.stringify(result)).not.toContain('Rina owns Harbor.')
})
it('loads incrementally, filters deletions and clears all old rows on reset generation', async () => {
  const { store, search } = searchFixture()
  const ids = approve(store)
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.forget(ids[0]!)
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(1)
  const next = extraction('next')
  approve(store, { jobId: 'next', memories: [next.memories[0]!], memoryVectors: [vector()] })
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.reset()
  await search.refresh()
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

it('refresh reads maintained counts instead of scanning all bit rows', async () => {
  const { store, search, path } = searchFixture()
  approve(store)
  await search.refresh()
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

it('find ranks exact keys and exact names ahead of word and trigram candidates', () => {
  const { search, path } = searchFixture()
  const db = new DatabaseSync(path)
  try {
    for (let n = 1; n <= 11; n++) {
      db.prepare("INSERT INTO entities(n,id,label,kind,created_at) VALUES (?,?,?,'ticket',1)").run(
        n,
        `ticket-${n}`,
        `Ticket ${n}`,
      )
      db.prepare('INSERT INTO entity_words(rowid,text) VALUES (?,?)').run(n, `Ticket ${n}`)
    }
    db.exec(`
      INSERT INTO entities(n,id,label,kind,created_at) VALUES (12,'kestrel','Kestrel','project',1);
      INSERT INTO entity_keys VALUES ('ticket','27',12);
      INSERT INTO entity_names(entity,name,folded) VALUES (12,'Kestrel','kestrel');
      INSERT INTO entity_words(rowid,text) VALUES (12,'Kestrel');
    `)
    expect(search.find('ticket:27', null, 5).entities[0]?.id).toBe('kestrel')
    expect(search.find('ticket Kestrel', null, 5).entities[0]?.id).toBe('kestrel')
  } finally {
    db.close()
  }
})

it('find does not scan vectors whose results would be truncated behind a full lexical page', async () => {
  const { store, search } = searchFixture()
  approve(store)
  await search.refresh()
  const lexical = search.find('Harbor', null, 1)
  const nearest = vi.spyOn(VectorIndex.prototype, 'nearest')
  try {
    expect(search.find('Harbor', vector(), 1)).toEqual(lexical)
    expect(nearest).not.toHaveBeenCalled()
  } finally {
    nearest.mockRestore()
  }
})
