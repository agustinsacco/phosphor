import { expect, it } from 'vitest'
import { fixture, lane, save } from './test-support'

const note = { runId: null, reason: 'These claims came from a test conversation.' }

it('undoing a saved read leaves the read rejected with nothing saved, its record kept, and Read again offered', () => {
  const { store, db } = fixture()
  const saved = save(store)
  const job = store.job(saved.jobId)!
  store.saveExtraction({
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'off',
    calls: [],
    outcomes: [],
    error: null,
    startedAt: 100,
    finishedAt: 200,
  })
  store.agentUndo(saved.operationId!, note)
  expect(store.job(saved.jobId)).toMatchObject({ state: 'rejected', memories: 0 })
  expect(store.snapshot().counts.memories).toBe(0)
  expect(() => store.extraction(saved.jobId)).not.toThrow()
  expect(store.laneRead('harbor-lane')?.job.id).toBe(saved.jobId)
  const again = store.enqueue(lane({ replaces: saved.jobId }), 'queued')
  expect(again.replaces).toBe(saved.jobId)
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='running'").get()).toEqual({
    n: 0,
  })
})
it('a saved read closes the read questions it opened when it is undone', () => {
  const { store } = fixture()
  const saved = save(store, {
    groups: [
      {
        parent: { label: 'Harbor group', kind: 'organization', entityId: null },
        members: ['harbor', 'rina', 'tom'],
      },
    ],
  })
  expect(store.waitingCounts().groups).toBe(1)
  store.agentUndo(saved.operationId!, note)
  expect(store.waitingCounts().groups).toBe(0)
  expect(() => store.enqueue(lane({ leafId: 'leaf-again' }), 'queued')).not.toThrow()
})
