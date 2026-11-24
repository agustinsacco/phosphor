import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { hub, seed } from './test-support'

it('reports no capped buckets for four matching people with small memory windows', () => {
  const { store, db } = fixture()
  seed(db, 4)
  let result = store.sweep('all')
  while (result.coverage.phase !== 'done') result = store.sweep('all')
  expect(result.coverage).toMatchObject({ entities: 4, memories: 4, limitedChecks: 0 })
})

it('counts one limited check when one memory mentions six people', () => {
  const { store, db } = fixture()
  seed(db, 6)
  db.exec('INSERT INTO mentions VALUES (1,2),(1,3),(1,4),(1,5),(1,6)')
  let result = store.sweep('all')
  while (result.coverage.phase !== 'done') result = store.sweep('all')
  expect(result.coverage).toMatchObject({ entities: 6, memories: 6, limitedChecks: 1 })
})

it('a whole-Brain pass covers memories deferred behind its cursor before it reports done', () => {
  const { store, db } = fixture()
  hub(db, 2100)
  // Memories past the hub keep the pass running after its cursor has passed the hub.
  const memory = db.prepare(
    "INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (?,?,?,'fact','reported','/Kestrel',NULL,NULL,NULL,?,?,'active','kestrel-lane','Kestrel',NULL)",
  )
  for (let n = 2103; n <= 2402; n++)
    memory.run(n, `kestrel-${n}`, `Kestrel ships build ${n}.`, n, n)
  let pass = store.sweep('all')
  while (!(pass.coverage.phase === 'memories' && pass.coverage.cursor >= 2102))
    pass = store.sweep('all')
  store.merge('rina-2', 'rina-1', store.revision())
  // A restart loses the pending list; only the missing fingerprints remain.
  store.takeTidyMaintenance()
  while (pass.coverage.phase !== 'done') pass = store.sweep('all')
  const unkeyed = db
    .prepare(
      "SELECT COUNT(*) AS count FROM memories m WHERE state='active' AND NOT EXISTS(SELECT 1 FROM tidy_memory_keys k WHERE k.memory=m.n)",
    )
    .get() as { count: number }
  expect(unkeyed.count).toBe(0)
  expect(store.tidySummary().automaticFolds).toBe(1)
})
