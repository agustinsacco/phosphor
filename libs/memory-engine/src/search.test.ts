import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { saveAndListMemories, extraction, searchFixture, vector } from './test-support'
import { freshness } from './recall'
import { named } from './seeds'

it('degrades during initial loading, then recalls paraphrases through vectors with no evidence text', async () => {
  const { store, search } = searchFixture()
  saveAndListMemories(store)
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
  const ids = saveAndListMemories(store)
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.forget(ids[0]!)
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(1)
  const next = extraction('next')
  saveAndListMemories(store, {
    jobId: 'next',
    memories: [next.memories[0]!],
    memoryVectors: [vector()],
  })
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toHaveLength(2)
  store.reset()
  await search.refresh()
  expect(search.nearestMemories([vector()], 10)[0]).toEqual([])
  expect(search.find('Harbor', vector(), 20).entities).toEqual([])
})
it('find returns entities and memories with referenced entity cards and bounded limits', () => {
  const { store, search } = searchFixture()
  saveAndListMemories(store)
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
  const [id] = saveAndListMemories(store)
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
  saveAndListMemories(store)
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
      db.prepare("INSERT INTO entities(n,id,label,kind,created_at) VALUES (?,?,?,'concept',1)").run(
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

/** A made-up Brain whose memories sit at different distances from the query vector. */
async function rankedBrain() {
  const fixture = searchFixture()
  const data = extraction('ranked')
  const sentences = [
    'Rina Okafor owns the Harbor billing service.',
    'Harbor bills Ledger customers weekly.',
    'Tom Lee archives Harbor invoices.',
    'Rina reviews Ledger refunds on Fridays.',
    'Kestrel replaces the Harbor export job.',
    'Harbor keeps invoices for seven years.',
  ]
  saveAndListMemories(fixture.store, {
    jobId: 'ranked',
    memories: sentences.map((summary, i) => ({
      ...data.memories[i % 2]!,
      summary,
      citations: [{ evidence: 0, quote: summary }],
      links: [],
    })),
    memoryVectors: sentences.map((_, i) => vector(1, i / 3, i % 2)),
  })
  await fixture.search.refresh()
  return fixture
}
it.each(['Harbor', 'Rina', 'Ledger refunds', 'invoices'])(
  'find returns the memories brain_search ranks first for "%s", in its order',
  async (query) => {
    const { search } = await rankedBrain()
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now })
    try {
      for (const limit of [1, 3, 8, 20]) {
        const recall = search.recall({
          query,
          vector: vector(1, 0.4),
          limit,
          scope: null,
          branch: null,
          now,
        })
        const found = search.find(query, vector(1, 0.4), limit)
        expect(recall.hits.length).toBeGreaterThan(0)
        expect(found.memories.map((m) => m.id)).toEqual(recall.hits.map((hit) => hit.memory.id))
      }
    } finally {
      vi.useRealTimers()
    }
  },
)
it('find lists people and things matched by name or alias before nearby ones, within the limit', async () => {
  const { search } = await rankedBrain()
  const found = search.find('Rina', vector(1, 0.4), 50)
  expect(found.entities[0]?.label).toBe('Rina Okafor')
  expect(found.memories.length).toBeLessThanOrEqual(50)
  expect(search.find('Rina', vector(1, 0.4), 2).memories).toHaveLength(2)
  expect(search.find('Rina', vector(1, 0.4), 2).entities.length).toBeLessThanOrEqual(2)
})
