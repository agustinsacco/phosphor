import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { hub } from './test-support'

/** Journal rows of one operation, with the memory a before-image belongs to, if any. */
function journalRows(db: ReturnType<typeof fixture>['db'], operation: string) {
  return (
    db
      .prepare('SELECT table_name,before_image FROM tidy_operation_rows WHERE operation_id=?')
      .all(operation) as { table_name: string; before_image: string }[]
  ).map((row) => {
    const image = JSON.parse(row.before_image) as {
      key: Record<string, unknown>
      row: Record<string, unknown> | null
    }
    return { table: row.table_name, image, bytes: row.before_image.length }
  })
}

it('a merge into a 2,000-memory hub journals the rows it changed, not the hub', () => {
  const { store, db } = fixture()
  hub(db, 2000)
  const operation = store.merge('rina-2', 'rina-1', store.revision())
  const rows = journalRows(db, operation)
  expect(rows.filter((r) => r.table === 'memory_vectors')).toEqual([])
  // Only memory-2 and the planted hub memory mentioned rina-2; nothing else changed.
  const changed = new Set([2, 2002])
  const unchanged = rows.filter((r) => {
    const memory = Number(r.image.key.memory ?? r.image.row?.memory ?? r.image.key.n)
    return (
      ['memories', 'mentions', 'citations', 'evidence'].includes(r.table) &&
      r.image.row !== null &&
      !changed.has(memory)
    )
  })
  expect(unchanged).toEqual([])
  expect(rows.length).toBeLessThan(30)
  expect(rows.reduce((sum, r) => sum + r.bytes, 0)).toBeLessThan(10_000)
  store.tidyUndo(operation, store.revision())
  expect(store.memory('memory-2').memory.entityIds).toEqual(['rina-2'])
  expect(store.memory('hub-02000').memory.entityIds).toEqual(['rina-2'])
  expect(store.memory('hub-00001').memory.entityIds).toEqual(['rina-1'])
})
