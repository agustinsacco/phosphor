import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane } from './test-support'

describe('Brain memory details, dates and deletion', () => {
  it('returns link quotes, origin path and observed dates independently of approval time', () => {
    const { store } = fixture()
    const ids = approve(store)
    const detail = store.memory(ids.find((id) => store.memory(id).memory.type === 'fact')!)
    expect(detail.memory.observedAt).toBe(10)
    expect(detail.memory.recordedAt).toBeGreaterThan(1000)
    expect(detail.linkQuotes[detail.memory.links[0]!.id]?.[0]?.quote).toBe('Rina owns Harbor.')
    expect(detail.sourcePath).toBe('/made-up/harbor.jsonl')
    expect(() => store.memory('absent')).toThrow('Brain memory not found')
  })
  it('forgets rows, FTS, scoped orphan entities and evidence, retaining shared evidence', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.memories[1]!.citations = [{ evidence: 0, quote: 'Rina owns Harbor.' }]
    data.memories[1]!.links = []
    store.propose(data)
    store.review(job.id, { memories: [0, 1], identities: {}, groups: [] }, 0)
    const tom = store.overview(300).nodes.find((item) => item.label === 'Tom Lee')!
    const id = store.entityMemories(tom.id, {}, null).memories[0]!.id
    store.forget(id)
    expect(store.snapshot().counts).toEqual({ memories: 1, entities: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
    const remaining = store.entityMemories(store.overview(300).nodes[0]!.id, {}, null).memories[0]!
    store.forget(remaining.id)
    for (const table of [
      'evidence',
      'entities',
      'citations',
      'memory_vectors',
      'memory_bits',
      'memory_words',
      'relation_support',
    ])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
  })
  it('stores supersede history with validity and non-live historical relations', () => {
    const { store, db } = fixture()
    const [old] = approve(store)
    const data = extraction('next')
    const ids = approve(store, {
      jobId: 'next',
      memories: [{ ...data.memories[0]!, action: 'supersede', target: old!, validFrom: 5000 }],
      memoryVectors: data.memoryVectors.slice(0, 1),
    })
    const replacement = ids.find((id) => store.memory(id).history.some((item) => item.id === old))!
    expect(store.memory(old!).memory).toMatchObject({ state: 'superseded', validTo: 5000 })
    expect(store.memory(replacement).history.map((item) => item.id)).toContain(old)
    expect(
      db
        .prepare('SELECT live FROM relations WHERE memory=(SELECT n FROM memories WHERE id=?)')
        .get(old!),
    ).toEqual({ live: 0 })
    expect(
      db
        .prepare('SELECT rowid FROM memory_words WHERE rowid=(SELECT n FROM memories WHERE id=?)')
        .get(old!),
    ).toBeUndefined()
  })
})

it('uses the exact approval timestamp when source evidence is undated', () => {
  const { store } = fixture()
  const data = extraction('undated')
  const ids = approve(store, {
    evidence: data.evidence.map((entry) => ({ ...entry, observedAt: 0 })),
  })
  for (const id of ids) {
    const memory = store.memory(id).memory
    expect(memory.observedAt).toBe(memory.recordedAt)
  }
})
