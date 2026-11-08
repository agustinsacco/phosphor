import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'

describe('Brain knowledge', () => {
  it('lists active knowledge newest first, caps it and returns only referenced entities', () => {
    const { store } = fixture()
    approve(store)
    const full = store.knowledge()
    expect(full.memories.map((memory) => memory.type)).toEqual(['procedure', 'fact'])
    expect(full.truncated).toBe(false)
    const limited = store.knowledge(1)
    expect(limited.memories[0]).toEqual(full.memories[0])
    expect(limited.entities.map((item) => item.label)).toEqual(['Harbor', 'Tom Lee'])
    expect(limited.truncated).toBe(true)
    expect(store.knowledge(0)).toEqual({ memories: [], entities: [], truncated: true })
    expect(() => store.memory('missing')).toThrow('Brain memory not found.')
  })
  it('forgets citations, vectors, deliveries, FTS and orphan entities/evidence but keeps shared evidence', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.memories[1]!.citations = [{ evidence: 0, quote: 'Rina owns Harbor.' }]
    store.propose(data)
    store.review(job.id, [0, 1], 0)
    const tom = store.knowledge().memories.find((item) => item.summary.includes('Tom'))!
    const rina = store.knowledge().memories.find((item) => item.summary.includes('Rina'))!
    store.recordDelivery('reader', [tom.id, rina.id])
    store.forget(tom.id)
    expect(store.snapshot()).toMatchObject({ revision: 2, counts: { memories: 1, entities: 2 } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM citations').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM vectors').get()).toEqual({ n: 1 })
    expect(store.search({ query: 'Tom Lee', vector: null, scope: null, limit: 6 }).status).toBe(
      'no_match',
    )
    expect(store.knowledge().entities.map((item) => item.label)).not.toContain('Tom Lee')
    store.forget(rina.id)
    expect(store.snapshot()).toMatchObject({ revision: 3, counts: { memories: 0, entities: 0 } })
    for (const table of [
      'evidence',
      'entities',
      'citations',
      'vectors',
      'memory_fts',
      'deliveries',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })
  it('returns the newest union of delivered, own-origin and same-scope memories', () => {
    const { store } = fixture()
    approve(store)
    const harbor = store.knowledge().memories
    const base = extraction('unused')
    approve(store, {
      jobId: 'other-leaf',
      scope: '/other',
      origin: { sessionId: 'own-lane', title: 'Other' },
      memories: [{ ...base.memories[0]!, summary: 'Rina chooses the data retention period.' }],
      vectors: [vector(0, 0, 1)],
    })
    const own = store.knowledge().memories[0]!
    expect(store.known('own-lane', '/projects/harbor', 10).memories.map((item) => item.id)).toEqual(
      [own.id, ...harbor.map((item) => item.id)],
    )
    expect(store.known('reader', '/nowhere', 10).memories).toEqual([])
    store.recordDelivery('reader', [harbor[1]!.id, own.id, own.id, 'nonexistent'])
    expect(store.known('reader', '/nowhere', 10).memories.map((item) => item.id)).toEqual([
      own.id,
      harbor[1]!.id,
    ])
    expect(store.known('own-lane', '/projects/harbor', 1).memories.map((item) => item.id)).toEqual([
      own.id,
    ])
  })
  it('adds no more than sixty other entities to known context', () => {
    const { store, db } = fixture()
    approve(store)
    const insert = db.prepare('INSERT INTO entities VALUES (?,?,?,?,?)')
    for (let i = 0; i < 70; i++) insert.run(`other-${i}`, `Concept ${i}`, 'concept', '[]', i)
    const context = store.known('harbor-lane', '/projects/harbor', 20)
    expect(context.entities).toHaveLength(63)
    expect(
      context.entities.filter((item) => ['Harbor', 'Rina Okafor', 'Tom Lee'].includes(item.label)),
    ).toHaveLength(3)
  })
})
