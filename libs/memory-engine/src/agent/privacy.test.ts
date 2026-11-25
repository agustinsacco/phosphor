import { expect, it } from 'vitest'
import { fixture, extraction, save } from '../test-support'
import { seed } from '../tidy/test-support'
import type { DatabaseSync } from 'node:sqlite'

const note = { runId: null, reason: 'This claim is no longer supported.' }
function scan(db: DatabaseSync): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('extractions','job_parts','proposals','proposal_vectors')",
    )
    .all() as { name: string }[]
  return tables
    .flatMap(({ name }) =>
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) =>
          Object.values(row)
            .map((value) =>
              value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value),
            )
            .join('\n'),
        ),
    )
    .join('\n')
}
it('erasing a saved memory removes the read undo record, so the read can no longer be undone', () => {
  const { store, db } = fixture()
  const data = extraction('unused')
  const saved = save(store)
  const id = saved.touched.memoryIds[0]!
  expect(
    db
      .prepare('SELECT memory_id FROM tidy_operation_memories WHERE operation_id=?')
      .all(saved.operationId),
  ).toEqual(expect.arrayContaining([{ memory_id: id }]))
  const erased = db.prepare('SELECT summary FROM memories WHERE id=?').get(id)!.summary
  store.erase(id, note)
  expect(scan(db)).not.toContain(erased)
  expect(data.memories.map((m) => m.summary)).toContain(erased)
  expect(store.tidyChanges(50).items.find((item) => item.id === saved.operationId)?.undoable).toBe(
    false,
  )
  expect(() => store.agentUndo(saved.operationId!, note)).toThrow('forgotten')
})
it('forget also drops a read approval snapshot and erasure redacts prior agent reasons', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const quoted = 'The owner corrected RINA   LEADS LEDGER AREA 1.'
  const op = store.agentEdit(
    { kind: 'describe', entityId: 'rina-2', description: 'Ledger release lead' },
    { ...note, reason: quoted },
  )
  store.agentUndo(op, { ...note, reason: 'Undo: rina leads ledger area 1.' })
  store.erase('memory-1', note)
  expect(db.prepare('SELECT reason FROM agent_notes WHERE operation_id=?').all(op)).toEqual([
    { reason: 'Reason removed with an erased memory.' },
    { reason: 'Reason removed with an erased memory.' },
  ])
  expect(scan(db).toLowerCase()).not.toContain('rina leads ledger area 1.')
})
it('Forget removes the saved read snapshot that held the memory', () => {
  const { store, db } = fixture()
  const saved = save(store)
  const id = saved.touched.memoryIds[0]!
  const summary = db.prepare('SELECT summary FROM memories WHERE id=?').get(id)!.summary
  store.forget(id)
  expect(scan(db)).not.toContain(summary)
  expect(
    db
      .prepare('SELECT COUNT(*) AS n FROM tidy_operation_rows WHERE operation_id=?')
      .get(saved.operationId),
  ).toEqual({ n: 0 })
})
