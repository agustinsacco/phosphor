import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, running, save, vector } from '../test-support'
import { dump } from '../tidy/test-support'

const note = { runId: null, reason: 'The lane supports these claims.' }

it('undoes Read again, restoring the replaced memories and their entities and quotes', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const previous = store.laneRead('harbor-lane')!.job.id
  const jobId = running(store, { replaces: previous, leafId: 'leaf-2' })
  const data = extraction(jobId, { computedRevision: store.knowledgeRevision() })
  data.memories = data.memories.map((m) => ({ ...m, summary: `${m.summary} Updated for Ledger.` }))
  const before = dump(db)
  const saved = store.saveRead(data)
  expect(saved.replaced).toBe(2)
  for (const id of ids) expect(() => store.memory(id)).toThrow('not found')
  store.agentUndo(saved.operationId!, note)
  expect(dump(db)).toEqual(before)
})
it('refuses undo of a read once a later read of the lane finished', () => {
  const { store, db } = fixture()
  const saved = save(store, {
    memories: [extraction('unused').memories[0]!],
    memoryVectors: [vector()],
  })
  for (let i = 0; i < 21; i++) {
    const next = store.enqueue(lane({ leafId: `next-${i}` }), 'queued')
    store.updateJob(next.id, { state: 'empty', finishedAt: 100000 + i })
  }
  expect(store.job(saved.jobId)).toBeUndefined()
  const before = dump(db)
  expect(() => store.agentUndo(saved.operationId!, note)).toThrow(
    'Later changes touch this Brain change',
  )
  expect(dump(db)).toEqual(before)
})
