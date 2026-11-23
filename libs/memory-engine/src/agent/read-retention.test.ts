import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from '../test-support'
import { dump } from '../tidy/test-support'

const note = { runId: null, reason: 'The lane supports these claims.' }
const decision = {
  memories: [0, 1],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
}
it('undoes Read again, restoring the replaced memories and their entities and quotes', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const previous = store.history(50).items[0]!.job.id
  const job = store.enqueue(lane({ replaces: previous, leafId: 'leaf-2' }), 'queued')
  const data = extraction(job.id, { computedRevision: store.knowledgeRevision() })
  data.memories = data.memories.map((m) => ({ ...m, summary: `${m.summary} Updated for Ledger.` }))
  store.propose(data)
  const before = dump(db),
    proposal = store.proposal(job.id)
  const op = store.decideRead(job.id, decision, proposal.revision, note)
  for (const id of ids) expect(() => store.memory(id)).toThrow('not found')
  store.agentUndo(op.operationId, note)
  expect(dump(db)).toEqual(before)
  expect(store.proposal(job.id)).toEqual(proposal)
})
it('restores extraction outcomes on undo, and a stale undone approval waits in review', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.propose(extraction(job.id))
  store.saveExtraction({
    jobId: job.id,
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
  const before = store.extraction(job.id)
  const op = store.decideRead(job.id, decision, 0, note)
  expect(store.extraction(job.id).outcomes[0]?.memoryId).toBeTruthy()
  store.agentUndo(op.operationId, note)
  expect(store.extraction(job.id)).toEqual(before)
  expect(store.job(job.id)?.state).toBe('review')
  expect(store.proposal(job.id).revision).toBeLessThan(store.knowledgeRevision())
})
it('defers incidental retention pruning and refuses undo if a later finished read prunes its job', () => {
  const { store, db } = fixture()
  for (let i = 0; i < 20; i++) {
    const job = store.enqueue(lane({ leafId: `leaf-${i}` }), 'queued')
    store.updateJob(job.id, { state: 'empty', finishedAt: i })
  }
  const job = store.enqueue(lane({ leafId: 'leaf-agent' }), 'queued')
  const data = extraction(job.id, {
    memories: [extraction(job.id).memories[0]!],
    memoryVectors: [vector()],
  })
  store.propose(data)
  const op = store.decideRead(job.id, { ...decision, memories: [0] }, 0, note)
  expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 21 })
  for (let i = 0; i < 21; i++) {
    const next = store.enqueue(lane({ leafId: `next-${i}` }), 'queued')
    store.updateJob(next.id, { state: 'empty', finishedAt: 100000 + i })
  }
  expect(store.job(job.id)).toBeUndefined()
  const before = dump(db)
  expect(() => store.agentUndo(op.operationId, note)).toThrow(
    'Later changes touch this Brain change',
  )
  expect(dump(db)).toEqual(before)
})
it('bounds repeated agent approvals at 20 plus the newest decision by pruning on the next enqueue', () => {
  const { store, db } = fixture()
  const operations: { jobId: string; operationId: string }[] = []
  for (let i = 0; i < 25; i++) {
    const job = store.enqueue(lane({ leafId: `agent-leaf-${i}` }), 'queued')
    const data = extraction(job.id, {
      computedRevision: store.knowledgeRevision(),
      entities: [],
      entityVectors: [],
      memoryVectors: [vector()],
    })
    data.memories = [
      {
        ...data.memories[0]!,
        entities: [],
        links: [],
        summary: `Ledger records responsibility ${i}.`,
      },
    ]
    store.propose(data)
    const result = store.decideRead(
      job.id,
      { ...decision, memories: [0] },
      store.proposal(job.id).revision,
      note,
    )
    operations.push({ jobId: job.id, operationId: result.operationId })
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='done'").get() as { n: number }).n,
    ).toBeLessThanOrEqual(21)
  }
  const latest = operations.at(-1)!
  store.agentUndo(latest.operationId, note)
  expect(store.job(latest.jobId)?.state).toBe('review')
  store.propose({
    ...store.storedProposal(latest.jobId)!,
    computedRevision: store.knowledgeRevision(),
  })
  const reapplied = store.decideRead(
    latest.jobId,
    { ...decision, memories: [0] },
    store.proposal(latest.jobId).revision,
    note,
  )
  store.enqueue(lane({ leafId: 'next-after-agent' }), 'queued')
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='done'").get()).toEqual({ n: 20 })
  const before = dump(db)
  expect(() => store.agentUndo(reapplied.operationId, note)).toThrow(
    'Later changes touch this Brain change',
  )
  expect(dump(db)).toEqual(before)
  expect(() => store.agentUndo(operations[0]!.operationId, note)).toThrow(
    'Later changes touch this Brain change',
  )
  expect(dump(db)).toEqual(before)
})
