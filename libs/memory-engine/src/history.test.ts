import { expect, it } from 'vitest'
import {
  saveAndListMemories,
  extraction,
  fixture,
  lane,
  running,
  save,
  vector,
} from './test-support'

it("returns the lane's newest finished read and counts its surviving memories", () => {
  const { store } = fixture()
  const ids = saveAndListMemories(store)
  const old = store.memory(ids[0]!).memory.jobId!
  store.forget(ids[0]!)
  expect(store.laneRead('harbor-lane')).toMatchObject({
    job: { id: old },
    memories: 1,
    replaceable: 1,
  })
  const later = store.enqueue(lane({ leafId: 'leaf-later' }), 'queued')
  expect(store.laneRead('harbor-lane')?.job.id).toBe(old)
  store.updateJob(later.id, { state: 'empty', finishedAt: 9000 })
  expect(store.laneRead('harbor-lane')).toMatchObject({ job: { id: later.id }, memories: 0 })
  expect(store.laneRead('kestrel')).toBeNull()
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
it('reads the lane memories through the origin index', () => {
  const { store, db } = fixture()
  saveAndListMemories(store)
  const statements: string[] = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    statements.push(sql)
    return prepare(sql)
  }
  store.laneMemories('harbor-lane')
  const laneSql = statements.find((sql) => sql.includes('WHERE m.origin_session=?'))!
  const plan = JSON.stringify(
    prepare(`EXPLAIN QUERY PLAN ${laneSql}`).all('harbor-lane', null, null),
  )
  expect(plan).toContain('memories_origin')
})
it('counts current memories of the newest read while the replacement count spans the lane', () => {
  const { store, db } = fixture()
  save(store)
  const data = extraction('')
  const second = save(store, { memories: data.memories.slice(0, 1), memoryVectors: [vector()] })
  expect(store.laneRead('harbor-lane')).toMatchObject({
    job: { id: second.jobId },
    memories: 1,
    replaceable: 3,
  })
  const next = running(store, { replaces: second.jobId, leafId: 'leaf-again' })
  const again = extraction(next, { computedRevision: store.knowledgeRevision() })
  store.saveRead({ ...again, memories: again.memories.slice(0, 1), memoryVectors: [vector()] })
  expect(store.laneRead('harbor-lane')).toMatchObject({ job: { id: next }, memories: 1 })
  db.prepare("UPDATE memories SET state='superseded' WHERE job_id=?").run(next)
  expect(store.laneRead('harbor-lane')?.memories).toBe(0)
})
