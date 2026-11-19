import { expect, it } from 'vitest'
import { approve, fixture, lane } from './test-support'

it('returns newest finished reads, bounded with more, and counts surviving lane memories', () => {
  const { store } = fixture()
  const ids = approve(store)
  const old = store.memory(ids[0]!).memory.jobId!
  store.forget(ids[0]!)
  const later = store.enqueue(lane({ sessionId: 'ledger' }), 'queued')
  store.updateJob(later.id, { state: 'done', finishedAt: 9000 })
  store.enqueue(lane({ sessionId: 'kestrel' }), 'queued')
  expect(store.history).toBeTypeOf('function')
  expect(store.history(1)).toMatchObject({
    items: [{ job: { id: later.id }, memories: 0 }],
    more: true,
  })
  expect(store.history(2)).toMatchObject({
    items: [{ job: { id: later.id } }, { job: { id: old }, memories: 1, replaceable: 1 }],
    more: false,
  })
  expect(store.snapshot().jobs).toHaveLength(1)
})
it('retains completed step inputs and removes proposal vectors with their proposal', () => {
  const { store, db } = fixture()
  const id = store.enqueue(lane(), 'queued').id
  store.savePart(id, { part: 'input:extract:1', inputHash: 'hash', output: 'Harbor inputs' })
  store.updateJob(id, { state: 'done' })
  expect(store.part(id, 'input:extract:1', 'hash')?.output).toBe('Harbor inputs')
  store.removeJob(id)
  expect(db.prepare('SELECT * FROM job_parts').all()).toEqual([])
})

it('uses indexed reads and one grouped count for the history page', () => {
  const { store, db } = fixture()
  approve(store)
  const statements: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    statements.push(sql)
    return prepare(sql)
  }
  expect(store.history).toBeTypeOf('function')
  store.history(20)
  store.laneMemories('harbor-lane')
  const historySql = statements.find(
    (sql) =>
      sql.includes("WHERE state IN ('done','empty','rejected')") && sql.includes('finished_at'),
  )!
  const countSql = statements.find((sql) => sql.includes('GROUP BY m.origin_session'))!
  const laneSql = statements.find((sql) => sql.includes('WHERE m.origin_session=?'))!
  expect(statements.filter((sql) => sql.includes('COUNT(*)'))).toHaveLength(1)
  const plan = (sql: string, args: (string | number | null)[]) =>
    JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args))
  expect(plan(historySql, [21])).toContain('jobs_finished')
  expect(plan(countSql, ['harbor-lane'])).toContain('memories_origin')
  expect(plan(laneSql, ['harbor-lane', null, null])).toContain('memories_origin')
  expect(plan(historySql, [21])).not.toMatch(/SCAN jobs/)
  expect(plan(countSql, ['harbor-lane'])).not.toMatch(/SCAN m\b/)
})
