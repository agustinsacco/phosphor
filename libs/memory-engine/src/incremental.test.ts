import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane } from './test-support'

it('retains a rejected read as rejected and continues after its leaf', () => {
  const { store } = fixture()
  approve(store)
  const job = store.enqueue(lane({ leafId: 'rejected-leaf' }), 'queued')
  store.propose(extraction(job.id, { computedRevision: store.knowledgeRevision() }))
  store.review(job.id, null, store.proposal(job.id).revision)
  expect(store.job(job.id)?.state).toBe('rejected')
  expect(store.history(20).items).toHaveLength(2)
  expect(store.snapshot().jobs).toEqual([])
  expect(store.enqueue(lane({ leafId: 'new' }), 'queued').fromLeafId).toBe('rejected-leaf')
})
it('Read again has no incremental cursor and bounded lane context includes only current memories', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const old = store.history(1).items[0]!.job
  db.prepare("UPDATE memories SET state='superseded' WHERE id=?").run(ids[0]!)
  expect(store.laneContext(old.sessionId)).toEqual([store.memory(ids[1]!).memory.summary])
  expect(store.enqueue(lane({ replaces: old.id }), 'queued').fromLeafId).toBeNull()
})
