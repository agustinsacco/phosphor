import type { BrainExtractionRecord } from '@phosphor/shared/brain'
import { expect, it } from 'vitest'
import { extraction, fixture, lane, vector } from './test-support'

it('links approved outcomes to memories and retains records until last memory is forgotten', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const record: BrainExtractionRecord = {
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    calls: [],
    outcomes: [{ candidate: 'w1:c1', summary: 'Harbor', status: 'kept', proposalIndex: 0 }],
    error: null,
    startedAt: 1000,
    finishedAt: 1001,
  }
  store.saveExtraction(record)
  store.propose(extraction(job.id))
  store.review(job.id, { memories: [0, 1], identities: {}, groups: [] }, 0)
  const saved = store.extraction(job.id)
  expect(saved.outcomes[0]?.memoryId).toBe(
    saved.memories.find((item) => item.summary.includes('owns'))?.id,
  )
  store.forget(saved.memories[0]!.id)
  expect(store.extraction(job.id).memories).toHaveLength(1)
  store.forget(saved.memories[1]!.id)
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
})
it('applies explicit confirmations without duplicate quotes and moves observedAt forward', () => {
  const { store } = fixture()
  const first = store.enqueue(lane(), 'queued')
  store.propose(extraction(first.id))
  store.review(first.id, { memories: [0], identities: {}, groups: [] }, 0)
  const id = store.entityMemories(store.overview(300).nodes[0]!.id, {}, null).memories[0]!.id
  const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
  const data = extraction(job.id, {
    computedRevision: store.revision(),
    memories: [],
    memoryVectors: [],
    confirmations: [{ memoryId: id, claim: extraction('').memories[0]!, vector: vector() }],
  })
  data.evidence[0]!.observedAt = 9000
  store.propose(data)
  store.review(job.id, { memories: [], identities: {}, groups: [] }, store.revision())
  expect(store.memory(id).quotes).toHaveLength(1)
  expect(store.memory(id).memory.observedAt).toBe(9000)
})
