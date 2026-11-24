import { expect, it } from 'vitest'
import { approve, fixture, lane } from './test-support'

it('Read again has no incremental cursor and bounded lane context includes only current memories', () => {
  const { store, db } = fixture()
  const ids = approve(store)
  const old = store.laneRead('harbor-lane')!.job
  db.prepare("UPDATE memories SET state='superseded' WHERE id=?").run(ids[0]!)
  expect(store.laneContext(old.sessionId)).toEqual([store.memory(ids[1]!).memory.summary])
  expect(store.enqueue(lane({ replaces: old.id }), 'queued').fromLeafId).toBeNull()
})
