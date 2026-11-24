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
it('links extraction outcomes to saved memories and keeps the record after undo', () => {
  const { store } = fixture()
  const jobId = running(store)
  const job = store.job(jobId)!
  store.saveExtraction({
    jobId,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'off',
    calls: [],
    outcomes: [
      { summary: 'Rina owns Harbor.', candidate: 'w1:c1', status: 'kept', proposalIndex: 0 },
    ],
    error: null,
    startedAt: 100,
    finishedAt: 200,
  })
  const saved = store.saveRead(extraction(jobId))
  const memoryId = store.extraction(jobId).outcomes[0]?.memoryId
  expect(memoryId).toBeTruthy()
  store.agentUndo(saved.operationId!, note)
  expect(store.extraction(jobId).outcomes[0]).toMatchObject({ memoryId, removed: true })
})
it('keeps at most 20 finished reads a lane as reads save, and undoes only the newest', () => {
  const { store, db } = fixture()
  const operations: string[] = []
  for (let i = 0; i < 25; i++) {
    const data = extraction('unused')
    const saved = save(store, {
      entities: [],
      entityVectors: [],
      memoryVectors: [vector()],
      memories: [
        {
          ...data.memories[0]!,
          entities: [],
          links: [],
          summary: `Ledger records responsibility ${i}.`,
        },
      ],
    })
    operations.push(saved.operationId!)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='done'").get() as { n: number }).n,
    ).toBeLessThanOrEqual(20)
  }
  expect(() => store.agentUndo(operations[0]!, note)).toThrow('Later changes')
  store.agentUndo(operations.at(-1)!, note)
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='done'").get()).toEqual({ n: 19 })
})
