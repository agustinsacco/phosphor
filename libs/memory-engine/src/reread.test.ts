import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { saveAndListMemories, extraction, fixture, lane, running, save } from './test-support'
import { seed } from './tidy/test-support'
import type { BrainStore } from './types'

const note = { runId: null, reason: 'The property test found this order.' }

/** Saves the chosen memories of the default read for a running job. */
function saveSome(store: BrainStore, jobId: string, indexes: number[]) {
  const data = extraction(jobId, { computedRevision: store.knowledgeRevision() })
  return store.saveRead({
    ...data,
    memories: indexes.map((i) => data.memories[i]!),
    memoryVectors: indexes.map((i) => data.memoryVectors[i]!),
  })
}

it.each(['waiting', 'queued', 'running', 'failed'] as const)(
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
it.each([{ selected: [0] }])(
  'a saved read %j replaces all unshared lane memories, with correct counters',
  ({ selected }) => {
    const { store, db } = fixture()
    const ids = saveAndListMemories(store)
    const old = store.memory(ids[0]!).memory.jobId!
    // A changed leaf lets old code reach the approval assertion.
    const job = running(store, { leafId: 'new', replaces: old })
    expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
    saveSome(store, job, selected)
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
it.each(['citation', 'relation'] as const)(
  'keeps an independently supported %s memory unchanged but counts it in history',
  (support) => {
    const { store, db } = fixture()
    const ids = saveAndListMemories(store)
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
    expect(store.laneRead('harbor-lane')?.replaceable).toBe(1)
    const job = running(store, { leafId: 'new', replaces: old })
    expect(saveSome(store, job, [1]).replaced).toBe(1)
    expect(store.memory(ids[0]!).memory).toEqual(before.memory)
    expect(store.memory(ids[0]!).quotes).toEqual(before.quotes)
    expect(store.memory(ids[0]!).linkQuotes).toEqual(before.linkQuotes)
    expect(() => store.memory(ids[1]!)).toThrow('Brain memory not found')
    expect(store.laneRead('harbor-lane')).toMatchObject({ job: { id: job }, memories: 1 })
    expect(store.snapshot().counts.memories).toBe(2)
  },
)
it('rolls back new saves, old removal, counters and job finalization together on a deletion failure', () => {
  const { store, db } = fixture()
  const ids = saveAndListMemories(store)
  const old = store.memory(ids[0]!).memory.jobId!
  const job = running(store, { leafId: 'new', replaces: old })
  const before = store.snapshot()
  db.exec(
    `CREATE TRIGGER fail_removal BEFORE DELETE ON memories WHEN OLD.job_id='${old}' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
  )
  expect(() => saveSome(store, job, [0])).toThrow('simulated crash')
  expect(store.snapshot()).toEqual(before)
  expect(db.prepare('SELECT id FROM memories WHERE job_id=?').all(job)).toEqual([])
  expect(store.job(job)?.state).toBe('running')
  expect(ids.map((id) => store.memory(id).memory.id)).toEqual(ids)
  expect(store.job(old)?.state).toBe('done')
})
it('replaces all lane provenance, including memories whose old job is gone, but never null provenance', () => {
  const { store, db } = fixture()
  const ids = saveAndListMemories(store)
  const first = store.memory(ids[0]!).memory.jobId!
  const last = store.enqueue(lane({ leafId: 'later' }), 'queued')
  store.updateJob(last.id, { state: 'done' })
  store.removeJob(first)
  expect(store.job(first)).toBeUndefined()
  db.prepare('UPDATE memories SET origin_session=NULL WHERE id=?').run(ids[1]!)
  const job = running(store, { leafId: 'new', replaces: last.id })
  saveSome(store, job, [0])
  expect(db.prepare('SELECT id FROM memories WHERE job_id IS NOT ? ORDER BY n').all(job)).toEqual([
    { id: ids[1] },
  ])
})
it.each(['empty', 'failed', 'cancelled'] as const)(
  '%s rereads leave earlier knowledge and finished history intact',
  (state) => {
    const { store } = fixture()
    const ids = saveAndListMemories(store)
    const old = store.memory(ids[0]!).memory.jobId!
    const job = running(store, { leafId: 'new', replaces: old })
    if (state === 'cancelled') store.removeJob(job)
    else if (state === 'empty') expect(saveSome(store, job, []).state).toBe('empty')
    else store.updateJob(job, { state: 'failed', error: 'Fake permanent failure' })
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
      const job = running(store, patch)
      const before = { prunes, revision: store.revision() }
      saveSome(store, job, [0, 1])
      expect(store.revision()).toBe(before.revision + 1)
      return prunes - before.prunes
    }
    const plain = save({})
    expect(plain).toBeGreaterThan(0)
    const old = store.laneRead('harbor-lane')!
    expect(old.replaceable).toBe(2)
    expect(save({ leafId: 'new', replaces: old.job.id })).toBe(plain)
    expect(store.laneRead('harbor-lane')).toMatchObject({ memories: 2, replaceable: 2 })
  } finally {
    store.close()
  }
})
it('Read again keeps earlier undo records: a merge undone after the read is undone restores fully', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const first = save(store)
  const rina = (
    db.prepare("SELECT id FROM entities WHERE label='Rina Okafor' AND id<>'rina-1'").get() as {
      id: string
    }
  ).id
  const merge = store.agentEdit({ kind: 'merge', sourceId: rina, targetId: 'rina-1' }, note)
  const job = running(store, { replaces: first.jobId, leafId: 'leaf-again' })
  const data = extraction(job, { computedRevision: store.knowledgeRevision() })
  const again = store.saveRead({
    ...data,
    memories: [data.memories[1]!],
    memoryVectors: [data.memoryVectors[1]!],
  })
  expect(again.replaced).toBe(2)
  store.agentUndo(again.operationId!, note)
  const owner = () =>
    db
      .prepare(
        "SELECT e.id FROM relations r JOIN entities e ON e.n=r.subject WHERE r.predicate='owns'",
      )
      .all()
  let refused = false
  try {
    store.agentUndo(merge, note)
  } catch {
    refused = true
  }
  if (!refused) expect(owner()).toEqual([{ id: rina }])
  else expect(owner()).toEqual([{ id: 'rina-1' }])
})
