import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'
import type { ProposalMemory } from './types'

it.each(['supersede', 'resolve_open', 'enrich', 'conflict'] as const)(
  'supersede followed by %s never mutates a retired target or double-decrements counts',
  (action) => {
    const { store, db } = fixture()
    const [target] = approve(store)
    const old = store.memory(target!).memory
    const job = store.enqueue(lane({ sessionId: 'second' }), 'queued')
    const p = extraction(job.id, { computedRevision: store.revision() })
    const claim: ProposalMemory = {
      ...p.memories[0]!,
      entities: old.entityIds,
      links: [],
      target: target!,
      action: 'supersede',
    }
    const link = {
      subject: old.entityIds[0]!,
      predicate: 'related_to' as const,
      object: old.entityIds[1]!,
      citation: claim.citations[0]!,
    }
    p.entities = []
    p.entityVectors = []
    p.memories = [
      claim,
      { ...claim, summary: 'Another supported assertion.', action, links: [link] },
    ]
    p.memoryVectors = [vector(), vector()]
    store.propose(p)
    store.review(job.id, { memories: [0, 1], identities: {}, groups: [] }, p.computedRevision)
    expect(store.snapshot().counts.memories).toBe(3)
    expect(store.memory(target!).memory.state).toBe('superseded')
    expect(store.memory(target!).memory.links).toEqual(old.links)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM relations r JOIN memories m ON m.n=r.memory WHERE m.state='superseded' AND r.live=1",
        )
        .get(),
    ).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM memory_words').get()).toEqual({ n: 3 })
    expect(db.prepare('SELECT COUNT(*) n FROM memory_bits').get()).toEqual({ n: 3 })
  },
)

it('skips a confirmation whose target was retired earlier in the approval', () => {
  const { store } = fixture()
  const [target] = approve(store)
  const before = store.memory(target!)
  const job = store.enqueue(lane({ sessionId: 'second' }), 'queued')
  const p = extraction(job.id, { computedRevision: store.revision() })
  p.memories = [{ ...p.memories[0]!, action: 'supersede', target: target! }]
  p.memoryVectors = [vector()]
  p.evidence[1]!.entryId = 'new-evidence'
  p.evidence[1]!.observedAt = 100000
  p.confirmations = [
    {
      memoryId: target!,
      claim: { ...extraction('').memories[0]!, citations: [{ evidence: 1, quote: 'fresh quote' }] },
      vector: vector(),
    },
  ]
  store.propose(p)
  store.review(job.id, { memories: [0], identities: {}, groups: [] }, p.computedRevision)
  expect(store.memory(target!).quotes).toEqual(before.quotes)
  expect(store.memory(target!).memory.observedAt).toBe(before.memory.observedAt)
})
