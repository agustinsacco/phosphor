import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane } from './test-support'

describe('Brain graph regressions', () => {
  it('lets a re-ingested lane enrich a saved memory with a supported link without duplicating citations', () => {
    const { store } = fixture()
    const initial = extraction('first')
    approve(store, { memories: initial.memories.map((memory) => ({ ...memory, links: [] })) })
    const nodes = store.overview(300).nodes
    const ids = nodes.map((node) => store.entityMemories(node.id, {}, null).memories).flat()
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const next = extraction(job.id, { computedRevision: store.revision() })
    next.entities = next.entities.map((entity) => ({ ...entity, decision: 'reuse', entityId: nodes.find((node) => node.label === entity.label)!.id }))
    next.memories = next.memories.map((memory) => ({ ...memory, action: 'enrich', target: ids.find((old) => old.summary === memory.summary)!.id }))
    store.propose(next)
    store.review(job.id, { memories: [0, 1], identities: {}, groups: [] }, store.revision())
    for (const id of new Set(ids.map((memory) => memory.id))) {
      expect(store.memory(id).memory.links).toHaveLength(1)
      expect(store.memory(id).quotes).toHaveLength(1)
    }
    expect(store.snapshot().counts.memories).toBe(2)
  })

  it('keeps an entity that only a superseded memory still names', () => {
    const { store, db } = fixture()
    approve(store)
    const tom = store.overview(300).nodes.find((node) => node.label === 'Tom Lee')!
    const old = store.entityMemories(tom.id, {}, null).memories[0]!
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const next = extraction(job.id, { computedRevision: store.revision() })
    next.entities = next.entities.filter((entity) => entity.ref !== 'tom')
    next.entityVectors = next.entityVectors.slice(0, 2)
    next.memories = [{ ...next.memories[0]!, summary: 'Rina maintains the archive now.', action: 'supersede', target: old.id }]
    next.memoryVectors = next.memoryVectors.slice(0, 1)
    store.propose(next)
    store.review(job.id, { memories: [0], identities: {}, groups: [] }, store.revision())
    expect(store.memory(old.id).memory.state).toBe('superseded')
    expect(store.entity(tom.id).entity.label).toBe('Tom Lee')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
