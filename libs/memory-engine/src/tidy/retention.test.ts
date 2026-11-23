import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { fixture, searchFixture, vector } from '../test-support'
import { seed } from './test-support'

it('retains only the newest 200 operations and immediately drops undone before-images', () => {
  const { store, db } = fixture()
  seed(db, 402)
  const operations: string[] = []
  for (let n = 1; n <= 402; n += 2)
    operations.push(store.merge(`rina-${n}`, `rina-${n + 1}`, store.revision()))
  expect(db.prepare('SELECT COUNT(*) AS n FROM tidy_operations').get()).toEqual({ n: 200 })
  expect(
    db.prepare('SELECT * FROM tidy_operation_rows WHERE operation_id=?').all(operations[0]!),
  ).toEqual([])
  expect(() => store.tidyUndo(operations[0]!, store.revision())).toThrow('no longer available')
  const latest = operations.at(-1)!
  store.tidyUndo(latest, store.revision())
  expect(db.prepare('SELECT * FROM tidy_operation_rows WHERE operation_id=?').all(latest)).toEqual(
    [],
  )
  expect(store.tidyChanges(50).items.find((op) => op.id === latest)?.undoneAt).not.toBeNull()
})
it('normal search refresh sees restored entity vectors below its old numeric watermark', async () => {
  const { store, search, path } = searchFixture()
  const db = new DatabaseSync(path)
  try {
    seed(db, 3)
    await search.refresh()
    const op = store.merge('rina-1', 'rina-3', store.revision())
    await search.refresh()
    expect(search.nearestEntities([vector(1, 0.1)], 3)[0]?.map((r) => r.id)).not.toContain('rina-1')
    store.tidyUndo(op, store.revision())
    await search.refresh()
    expect(search.nearestEntities([vector(1, 0.1)], 3)[0]?.[0]?.id).toBe('rina-1')
    expect(search.find('Rina', null, 10).entities).toHaveLength(3)
  } finally {
    db.close()
  }
})
it('validates versioned journal envelopes and refuses corrupt rows without changing knowledge', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const op = store.merge('rina-2', 'rina-1', store.revision())
  db.prepare(
    "UPDATE tidy_operation_rows SET before_image=? WHERE operation_id=? AND table_name='entities'",
  ).run('{"version":1,"key":{"n":2},"row":{"n":2,"unexpected":"Ledger"}}', op)
  expect(() => store.tidyUndo(op, store.revision())).toThrow('unreadable undo record')
  expect(store.snapshot().counts.entities).toBe(1)
})
