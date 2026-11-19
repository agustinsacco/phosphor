import { expect, it } from 'vitest'
import { extraction, fixture, lane } from './test-support'

it('allows rejection despite both stale proposal and stale client knowledge revisions', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.propose(extraction(job.id, { computedRevision: -1 }))
  expect(() => store.review(job.id, null, -1)).not.toThrow()
  expect(store.job(job.id)?.state).toBe('rejected')
  expect(store.storedProposal(job.id)).toBeUndefined()
  expect(store.snapshot().counts.memories).toBe(0)
  expect(store.knowledgeRevision()).toBe(0)
})
