import type { BrainExtractionRecord } from '@phosphor/shared/brain'
import { expect, it } from 'vitest'
import { extraction, fixture, lane, vector } from './test-support'
import type { BrainStore, Proposal } from './types'

/** Saves the chosen memories of a read, as the reader does once a read is finished. */
function saveSome(store: BrainStore, data: Proposal, indexes: number[]) {
  store.updateJob(data.jobId, { state: 'running' })
  store.saveRead({
    ...data,
    computedRevision: store.knowledgeRevision(),
    memories: indexes.map((i) => data.memories[i]!),
    memoryVectors: indexes.map((i) => data.memoryVectors[i]!),
  })
}

it('links approved outcomes to memories and retains records while the finished job exists, marking forgotten outcomes removed', () => {
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
  saveSome(store, extraction(job.id), [0, 1])
  const saved = store.extraction(job.id)
  expect(saved.outcomes[0]?.memoryId).toBe(
    saved.memories.find((item) => item.summary.includes('owns'))?.id,
  )
  store.forget(saved.memories[0]!.id)
  expect(store.extraction(job.id).memories).toHaveLength(1)
  store.forget(saved.memories[1]!.id)
  expect(() => store.extraction(job.id)).not.toThrow()
  expect(store.extraction(job.id).memories).toEqual([])
  expect(store.extraction(job.id).outcomes[0]).toMatchObject({ removed: true })
  store.removeJob(job.id)
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
})
it('applies explicit confirmations without duplicate quotes and moves observedAt forward', () => {
  const { store } = fixture()
  const first = store.enqueue(lane(), 'queued')
  saveSome(store, extraction(first.id), [0])
  const id = store.entityMemories(store.overview(300).nodes[0]!.id, {}, null).memories[0]!.id
  const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
  const data = extraction(job.id, {
    computedRevision: store.knowledgeRevision(),
    memories: [],
    memoryVectors: [],
    confirmations: [{ memoryId: id, claim: extraction('').memories[0]!, vector: vector() }],
  })
  data.evidence[0]!.observedAt = 9000
  saveSome(store, data, [])
  expect(store.memory(id).quotes).toHaveLength(1)
  expect(store.memory(id).memory.observedAt).toBe(9000)
})

it('keeps a record older than thirty days while its job exists', () => {
  const { store } = fixture(40 * 86400000)
  const job = store.enqueue(lane(), 'queued')
  store.updateJob(job.id, { state: 'done' })
  store.saveExtraction({
    ...job,
    jobId: job.id,
    thinking: 'low',
    calls: [],
    outcomes: [],
    startedAt: 1,
    finishedAt: 2,
  })
  expect(() => store.extraction(job.id)).not.toThrow()
  store.removeJob(job.id)
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
})

it('expires only orphaned referenced records at 30 days, and prunes unreferenced orphans immediately', () => {
  const { store, db } = fixture(40 * 86400000)
  const first = store.enqueue(lane(), 'queued')
  store.saveExtraction({
    ...first,
    jobId: first.id,
    thinking: 'low',
    calls: [],
    outcomes: [],
    startedAt: 1,
    finishedAt: 2,
  })
  saveSome(store, extraction(first.id), [0])
  expect(() => store.extraction(first.id)).not.toThrow()
  // Orphan a referenced record without invoking prune until the next write.
  db.prepare('DELETE FROM jobs WHERE id=?').run(first.id)
  const next = store.enqueue(lane(), 'queued')
  store.saveExtraction({
    ...next,
    jobId: next.id,
    thinking: 'low',
    calls: [],
    outcomes: [],
    startedAt: 1,
    finishedAt: 2,
  })
  expect(() => store.extraction(first.id)).toThrow('Brain extraction not found')
  expect(store.snapshot().counts.memories).toBe(1)
  store.removeJob(next.id)
  expect(() => store.extraction(next.id)).toThrow('Brain extraction not found')
})

it('prunes a displaced twenty-first read record even when its memories remain', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  saveSome(store, extraction(job.id), [0])
  store.saveExtraction({
    ...job,
    jobId: job.id,
    thinking: 'low',
    calls: [],
    outcomes: [],
    startedAt: 1,
    finishedAt: 2,
  })
  const memory = store.extraction(job.id).memories[0]!.id
  for (let i = 0; i < 20; i++) {
    const next = store.enqueue(lane({ leafId: `later-${i}` }), 'queued')
    store.updateJob(next.id, { state: 'done' })
  }
  expect(store.job(job.id)).toBeUndefined()
  expect(store.memory(memory).memory.jobId).toBe(job.id)
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
})
