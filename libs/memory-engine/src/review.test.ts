import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'

const keep = (memories: number[]) => ({ memories, identities: {}, groups: [] })
describe('Brain v4 review transaction', () => {
  it('approves only referenced identities and evidence with bounded quotes', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.evidence[0]!.text = `${'B'.repeat(200)}Rina owns Harbor.${'A'.repeat(200)}`
    store.propose(data)
    expect(store.proposal(job.id).memories[0]?.quotes[0]?.before).toHaveLength(160)
    store.review(job.id, keep([0, 0]), 0)
    expect(store.snapshot()).toMatchObject({
      revision: 1,
      counts: { memories: 1, entities: 2 },
      jobs: [],
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
    expect(store.overview(300).nodes.some((item) => item.label === 'Tom Lee')).toBe(false)
    expect(store.storedProposal(job.id)).toBeUndefined()
  })
  it('rejects invalid indexes and stale computed revisions before partial writes', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    expect(() => store.review(job.id, keep([0, 20]), 0)).toThrow('index is invalid')
    expect(store.revision()).toBe(0)
    approve(store, { origin: { sessionId: 'another', title: 'Ledger' } })
    expect(() => store.review(job.id, keep([0]), store.revision())).toThrow('Brain changed')
    expect(store.proposal(job.id).memories).toHaveLength(2)
  })
  it.each([null, keep([])])('rejects all with %j and remembers the leaf', (decision) => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    store.review(job.id, decision, 0)
    expect(store.snapshot().counts).toEqual({ memories: 0, entities: 0 })
    expect(() => store.enqueue(lane(), 'queued')).toThrow('Nothing new')
  })
  it('commits cross-kind explicit reuse and downgrades dependent actions when identity changes', () => {
    const { store } = fixture()
    const ids = approve(store)
    const old = store.memory(ids[0]!).memory
    const harbor = store.overview(300).nodes.find((item) => item.label === 'Harbor')!
    const next = extraction('next')
    next.entities[0] = {
      ...next.entities[0]!,
      kind: 'team',
      decision: 'reuse',
      entityId: harbor.id,
    }
    next.memories = [{ ...next.memories[0]!, action: 'supersede', target: old.id }]
    next.memoryVectors = [vector()]
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    store.propose({ ...next, jobId: job.id, computedRevision: store.revision() })
    store.review(
      job.id,
      { memories: [0], identities: { harbor: 'new' }, groups: [] },
      store.revision(),
    )
    expect(store.memory(old.id).memory.state).toBe('active')
    expect(store.overview(300).nodes.filter((item) => item.label === 'Harbor')).toHaveLength(2)
  })
  it('creates review-confirmed parent facts with explicit user evidence', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id, {
      memories: [],
      memoryVectors: [],
      groups: [
        {
          parent: { label: 'Harbor group', kind: 'organization', entityId: null },
          members: ['harbor', 'rina', 'tom'],
        },
      ],
    })
    store.propose(data)
    store.review(job.id, { memories: [], identities: {}, groups: [0] }, 0)
    expect(store.snapshot().counts).toEqual({ memories: 3, entities: 4 })
    const parent = store.overview(300).nodes.find((item) => item.label === 'Harbor group')!
    const fact = store.entityMemories(parent.id, {}, null).memories[0]!
    expect(store.memory(fact.id).quotes[0]?.label).toBe('Stated by you in review')
    expect(fact.links[0]?.predicate).toBe('part_of')
  })
  it('reactivates a disputed partner when its conflict is forgotten or superseded', () => {
    const { store } = fixture()
    const [id] = approve(store)
    const data = extraction('conflict')
    const ids = approve(store, {
      jobId: 'conflict',
      memories: [{ ...data.memories[0]!, action: 'conflict', target: id! }],
      memoryVectors: [vector()],
    })
    const conflict = ids.find(
      (candidate) => candidate !== id && store.memory(candidate).memory.state === 'disputed',
    )!
    expect(store.memory(id!).memory.state).toBe('disputed')
    store.forget(conflict)
    expect(store.memory(id!).memory.state).toBe('active')
  })
})

it('scrubs all persisted proposal and extraction free text again at the store boundary', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id)
  data.entities[0]!.description = 'token=harbor-secret'
  data.memories[0]!.summary = 'Write to tom@example.com'
  data.evidence[0]!.text = 'Bearer harbor-private'
  data.memories[0]!.citations[0]!.quote = 'Bearer harbor-private'
  store.propose(data)
  expect(String(db.prepare('SELECT payload FROM proposals').get()?.payload)).not.toContain(
    'harbor-private',
  )
  store.saveExtraction({
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: null,
    model: job.model,
    thinking: 'low',
    calls: [
      {
        stage: 'extract',
        part: 0,
        entryIds: [],
        inputHash: 'a',
        answer: 'Bearer harbor-private',
        trace: null,
        error: null,
      },
    ],
    outcomes: [],
    error: null,
    startedAt: 1,
    finishedAt: 2,
  })
  expect(store.extraction(job.id).calls[0]?.answer).toBe('[redacted]')
})

it('deduplicates evidence within the commit without a global evidence lookup', () => {
  const { store, db } = fixture()
  const statements: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    statements.push(sql)
    return prepare(sql)
  }
  approve(store)
  expect(statements.some((sql) => /SELECT n FROM evidence WHERE session_id/u.test(sql))).toBe(false)
})

it('does not duplicate relation evidence when enriching the same link from the same entry again', () => {
  const { store } = fixture()
  const [id] = approve(store)
  const memory = store.memory(id!).memory
  const link = memory.links[0]!
  const base = extraction('repeat')
  approve(store, {
    jobId: 'repeat',
    entities: [],
    entityVectors: [],
    memories: [
      {
        ...base.memories[0]!,
        action: 'enrich',
        target: id!,
        entities: memory.entityIds,
        links: [
          {
            subject: link.subjectId,
            object: link.objectId,
            predicate: link.predicate,
            citation: base.memories[0]!.citations[0]!,
          },
        ],
      },
    ],
    memoryVectors: [vector()],
  })
  expect(store.memory(id!).linkQuotes[link.id]).toHaveLength(1)
})
