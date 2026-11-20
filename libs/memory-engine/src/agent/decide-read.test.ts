import { describe, expect, it } from 'vitest'
import { fixture, extraction, lane, approve, vector } from '../test-support'
import { dump } from '../tidy/test-support'
import type { BrainStore, Proposal } from '../types'

const note = { runId: null, reason: 'The quoted claims are supported by the lane.' }
const decision = {
  memories: [0, 1],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
}
function waiting(store: BrainStore, patch: Partial<Proposal> = {}) {
  const job = store.enqueue(
    lane({
      leafId: `leaf-next-${store.revision()}`,
      sessionId: patch.origin?.sessionId ?? 'harbor-lane',
    }),
    'queued',
  )
  store.propose(
    extraction(job.id, { computedRevision: store.knowledgeRevision(), ...patch, jobId: job.id }),
  )
  return job.id
}
function readRows(db: ReturnType<typeof fixture>['db']) {
  return Object.fromEntries(
    ['jobs', 'proposals', 'proposal_vectors', 'extractions'].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  )
}

describe('Brain Agent read decisions', () => {
  it('approves and undoes every source table and restores an identical proposal', () => {
    const { store, db } = fixture()
    const id = waiting(store)
    const proposal = store.proposal(id)
    const before = dump(db),
      rows = readRows(db)
    const result = store.decideRead(id, decision, proposal.revision, note)
    expect(result.touched.memoryIds).toHaveLength(2)
    expect(store.job(id)?.state).toBe('done')
    expect(store.tidyChanges(50).items[0]).toMatchObject({
      id: result.operationId,
      who: 'agent',
      jobId: id,
      reason: note.reason,
      undoable: true,
    })
    store.agentUndo(result.operationId, { ...note, reason: 'Put this read back for another look.' })
    expect(dump(db)).toEqual(before)
    expect(readRows(db)).toEqual(rows)
    expect(store.proposal(id)).toEqual(proposal)
  })
  it('rejects stale reads and undoes the rejection', () => {
    const { store } = fixture()
    const id = waiting(store)
    const before = store.proposal(id)
    approve(store, { origin: { sessionId: 'ledger-lane', title: 'Ledger planning' } })
    const result = store.decideRead(id, null, before.revision, note)
    expect(store.job(id)?.state).toBe('rejected')
    store.agentUndo(result.operationId, note)
    expect(store.proposal(id)).toEqual(before)
    expect(store.job(id)?.state).toBe('review')
  })
  it('refuses a mismatched approval without changing anything', () => {
    const { store, db } = fixture()
    const id = waiting(store)
    const before = dump(db)
    expect(() => store.decideRead(id, decision, 999, note)).toThrow('Brain changed')
    expect(dump(db)).toEqual(before)
    expect(store.tidyChanges(50).items).toEqual([])
  })
  it('refuses undo after a later approval reuses a created entity or the job is retitled', () => {
    const { store, db } = fixture()
    const id = waiting(store)
    const result = store.decideRead(id, decision, store.proposal(id).revision, note)
    const entities = store.overview(50).nodes
    const later = extraction('unused')
    later.memories = later.memories.map((m) => ({
      ...m,
      summary: `${m.summary} The responsibility covers Ledger.`,
    }))
    later.entities = later.entities.map((e) => ({
      ...e,
      decision: 'reuse',
      entityId: entities.find((item) => item.label === e.label)!.id,
    }))
    const next = waiting(store, {
      ...later,
      computedRevision: store.knowledgeRevision(),
      origin: { sessionId: 'ledger-lane', title: 'Ledger planning' },
    })
    store.decideRead(next, decision, store.proposal(next).revision, note)
    const before = dump(db)
    expect(() => store.agentUndo(result.operationId, note)).toThrow(
      'Later changes touch this Brain change',
    )
    expect(dump(db)).toEqual(before)
    const latest = store.tidyChanges(50).items.find((o) => o.jobId === next)!
    store.updateJob(next, { title: 'Ledger renamed' })
    expect(() => store.agentUndo(latest.id, note)).toThrow('Later changes touch this Brain change')
  })
  it('restores confirmation quotes, vectors and superseded targets', () => {
    const { store, db } = fixture()
    const ids = approve(store)
    const old = extraction('unused')
    const target = ids[0]!
    const id = waiting(store, {
      entities: [],
      entityVectors: [],
      memories: [{ ...old.memories[0]!, entities: [], links: [], action: 'supersede', target }],
      memoryVectors: [vector()],
      confirmations: [
        {
          memoryId: ids[1]!,
          claim: { ...old.memories[1]!, entities: [], links: [] },
          vector: vector(),
        },
      ],
    })
    const before = dump(db)
    const result = store.decideRead(
      id,
      { ...decision, memories: [0] },
      store.proposal(id).revision,
      note,
    )
    store.agentUndo(result.operationId, note)
    expect(dump(db)).toEqual(before)
    expect(store.job(id)?.state).toBe('review')
  })
})
