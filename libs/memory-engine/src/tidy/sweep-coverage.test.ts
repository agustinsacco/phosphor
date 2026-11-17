import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from './test-support'

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
