import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { approve, extraction, fixture, lane } from './test-support'

it.each(['waiting', 'queued', 'running', 'review', 'empty', 'failed'] as const)(
  'refuses rereading a %s job',
  (state) => {
    const { store } = fixture()
    const old = store.enqueue(lane(), 'queued')
    store.updateJob(old.id, { state })
    expect(() => store.enqueue(lane({ replaces: old.id, sessionId: 'other' }), 'queued')).toThrow(
      'Only finished Brain reads can be read again.',
    )
  },
)
it('bypasses unchanged only for a reread and keeps replaces on Retry', () => {
  const { store } = fixture()
  const old = store.enqueue(lane(), 'queued')
  store.updateJob(old.id, { state: 'done' })
  expect(() => store.enqueue(lane(), 'queued')).toThrow('Nothing new')
  let result: ReturnType<typeof store.enqueue> | undefined
  expect(() => {
    result = store.enqueue(lane({ replaces: old.id }), 'waiting')
  }).not.toThrow()
  expect(result).toMatchObject({ replaces: old.id, state: 'waiting' })
  expect(() => store.enqueue(lane({ replaces: old.id }), 'queued')).toThrow('already queued')
  store.updateJob(result!.id, { state: 'failed' })
  expect(store.retry(result!.id).replaces).toBe(old.id)
})
it.each([{ selected: [0] }, { selected: [] }])(
  'approval %j replaces all unshared lane memories, with correct counters',
  ({ selected }) => {
    const { store, db } = fixture()
    const ids = approve(store)
    const old = store.memory(ids[0]!).memory.jobId!
    // A changed leaf lets old code reach the approval assertion.
    const job = store.enqueue(lane({ leafId: 'new', replaces: old }), 'queued')
    store.propose(extraction(job.id, { computedRevision: store.revision() }))
    expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
    store.review(
      job.id,
      { descriptions: [], memories: selected, identities: {}, groups: [] },
      store.revision(),
    )
    expect(db.prepare('SELECT id FROM memories WHERE job_id=?').all(old)).toEqual([])
    expect(store.snapshot().counts).toEqual({
      memories: selected.length,
      entities: selected.length * 2,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: selected.length })
    expect(db.prepare('SELECT memories,connections FROM entities').all()).toEqual(
      Array.from({ length: selected.length * 2 }, () => ({ memories: 1, connections: 1 })),
    )
    expect(db.prepare('SELECT * FROM proposal_vectors').all()).toEqual([])
  },
)
it('rejection of a replacing job preserves the previous done job; normal rejection stays done', () => {
  const { store } = fixture()
  const ids = approve(store)
  const old = store.memory(ids[0]!).memory.jobId!
  const job = store.enqueue(lane({ leafId: 'new', replaces: old }), 'queued')
  store.propose(extraction(job.id, { computedRevision: store.revision() }))
  store.review(job.id, null, store.revision())
  expect(store.job(old)?.state).toBe('done')
  expect(store.job(job.id)).toBeUndefined()
  expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
  const normal = store.enqueue(lane({ sessionId: 'ledger' }), 'queued')
  store.propose(extraction(normal.id, { computedRevision: store.revision() }))
  store.review(normal.id, null, store.revision())
  expect(store.job(normal.id)?.state).toBe('done')
})

it.each(['citation', 'relation'] as const)(
  'keeps an independently supported %s memory unchanged but counts it in history',
  (support) => {
    const { store, db } = fixture()
    const ids = approve(store)
    const old = store.memory(ids[0]!).memory.jobId!
    const n = db.prepare('SELECT n FROM memories WHERE id=?').get(ids[0]!)!.n
    db.exec(
      "INSERT INTO evidence VALUES (99,'ledger-lane','ledger-entry','user','Tom Lee',20,'Rina owns Harbor.')",
    )
    if (support === 'citation')
      db.prepare('INSERT INTO citations VALUES (?,99,?)').run(n!, 'Rina owns Harbor.')
    else
      db.prepare('INSERT INTO relation_support SELECT n,99,? FROM relations WHERE memory=?').run(
        'Rina owns Harbor.',
        n!,
      )
    const before = store.memory(ids[0]!)
    const job = store.enqueue(lane({ leafId: 'new', replaces: old }), 'queued')
    store.propose(extraction(job.id, { computedRevision: store.revision() }))
    expect(store.proposal(job.id).replacingMemories).toBe(1)
    store.review(
      job.id,
      { descriptions: [], memories: [], identities: {}, groups: [] },
      store.revision(),
    )
    expect(store.memory(ids[0]!).memory).toEqual(before.memory)
    expect(store.memory(ids[0]!).quotes).toEqual(before.quotes)
    expect(store.memory(ids[0]!).linkQuotes).toEqual(before.linkQuotes)
    expect(() => store.memory(ids[1]!)).toThrow('Brain memory not found')
    expect(store.history(10)).toMatchObject({ items: [{ memories: 1, replaceable: 0 }] })
    expect(store.snapshot().counts.memories).toBe(1)
  },
)
it('rolls back new saves, old removal, counters and job finalization together on a deletion failure', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const old = store.memory(ids[0]!).memory.jobId!
  const job = store.enqueue(lane({ leafId: 'new', replaces: old }), 'queued')
  store.propose(extraction(job.id, { computedRevision: store.revision() }))
  const before = store.snapshot()
  db.exec(
    `CREATE TRIGGER fail_removal BEFORE DELETE ON memories WHEN OLD.job_id='${old}' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
  )
  expect(() =>
    store.review(
      job.id,
      { descriptions: [], memories: [0], identities: {}, groups: [] },
      store.revision(),
    ),
  ).toThrow('simulated crash')
  expect(store.snapshot()).toEqual(before)
  expect(db.prepare('SELECT id FROM memories WHERE job_id=?').all(job.id)).toEqual([])
  expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
  expect(store.job(old)?.state).toBe('done')
})
it('replaces all lane provenance, including memories whose old job is gone, but never null provenance', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const first = store.memory(ids[0]!).memory.jobId!
  const last = store.enqueue(lane({ leafId: 'later' }), 'queued')
  store.updateJob(last.id, { state: 'done' })
  expect(store.job(first)).toBeUndefined()
  db.prepare('UPDATE memories SET origin_session=NULL WHERE id=?').run(ids[1]!)
  const job = store.enqueue(lane({ leafId: 'new', replaces: last.id }), 'queued')
  store.propose(extraction(job.id, { computedRevision: store.revision() }))
  store.review(
    job.id,
    { descriptions: [], memories: [], identities: {}, groups: [] },
    store.revision(),
  )
  expect(db.prepare('SELECT id FROM memories').all()).toEqual([{ id: ids[1] }])
})
it.each(['empty', 'failed', 'cancelled'] as const)(
  '%s rereads leave earlier knowledge and finished history intact',
  (state) => {
    const { store } = fixture()
    const ids = approve(store)
    const old = store.memory(ids[0]!).memory.jobId!
    const job = store.enqueue(lane({ leafId: 'new', replaces: old }), 'queued')
    if (state === 'cancelled') store.removeJob(job.id)
    else if (state === 'empty')
      store.propose(
        extraction(job.id, {
          computedRevision: store.revision(),
          memories: [],
          memoryVectors: [],
          groups: [],
          confirmations: [],
        }),
      )
    else store.updateJob(job.id, { state: 'failed', error: 'Fake permanent failure' })
    expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
    expect(store.job(old)?.state).toBe('done')
  },
)
it('replaces a lane with one revision bump and no extra pruning per removed memory', () => {
  let prunes = 0
  class Counting extends DatabaseSync {
    override prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
      const statement = super.prepare(sql)
      if (!sql.startsWith('DELETE FROM extractions')) return statement
      const counted = statement as unknown as { run: (...args: unknown[]) => unknown }
      const run = counted.run.bind(statement)
      counted.run = (...args) => {
        prunes++
        return run(...args)
      }
      return statement
    }
  }
  let counter = 0
  const store = openBrainStore({
    path: ':memory:',
    Database: Counting,
    id: () => `id-${++counter}`,
  })
  try {
    const save = (patch: Parameters<typeof lane>[0]): number => {
      const job = store.enqueue(lane(patch), 'queued')
      store.propose(extraction(job.id, { computedRevision: store.revision() }))
      const before = { prunes, revision: store.revision() }
      store.review(
        job.id,
        { descriptions: [], memories: [0, 1], identities: {}, groups: [] },
        store.revision(),
      )
      expect(store.revision()).toBe(before.revision + 1)
      return prunes - before.prunes
    }
    const plain = save({})
    expect(plain).toBeGreaterThan(0)
    const old = store.history(1).items[0]!
    expect(old.replaceable).toBe(2)
    expect(save({ leafId: 'new', replaces: old.job.id })).toBe(plain)
    expect(store.history(1).items[0]).toMatchObject({ memories: 2, replaceable: 2 })
  } finally {
    store.close()
  }
})
