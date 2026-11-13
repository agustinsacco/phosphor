import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane } from './test-support'

describe('Brain graph regressions', () => {
  it('lets a re-ingested lane add a supported link to a memory saved without one', () => {
    const { store } = fixture()
    const unlinked = extraction('first').memories.map((memory) => ({
      ...memory,
      predicate: 'about' as const,
      object: null,
      literal: 'billing service',
    }))
    approve(store, { memories: unlinked })
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    store.propose(extraction(job.id))
    store.review(job.id, [], store.snapshot().revision)
    const linked = store.knowledge().memories.filter((memory) => memory.objectId !== null)
    expect(linked.map((memory) => memory.predicate).sort()).toEqual(['owns', 'works_on'])
  })

  it('keeps an entity that only a superseded memory still names', () => {
    const { store, db } = fixture()
    const [owner] = approve(store)
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const data = extraction(job.id)
    data.memories = [
      {
        ...data.memories[0]!,
        summary: 'Rina Okafor handed Harbor billing to Ledger.',
        supersedes: owner!,
      },
    ]
    data.vectors = [data.vectors[1]!.map((x, i) => (i === 2 ? 1 : x)) as Float32Array]
    store.propose(data)
    store.review(job.id, [0], store.snapshot().revision)
    const tom = db.prepare("SELECT 1 AS found FROM entities WHERE label='Tom Lee'").get()
    expect(store.knowledge().memories.some((memory) => memory.summary.startsWith('Tom'))).toBe(true)
    expect(tom).toBeDefined()
  })
})
