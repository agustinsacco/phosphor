import { expect, it } from 'vitest'
import { fixture, extraction, lane } from '../test-support'
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
it('erasing an approved memory removes its entire proposal undo record, including rejected claims', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id)
  store.propose(data)
  const op = store.decideRead(
    job.id,
    { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
    0,
    note,
  )
  const id = op.touched.memoryIds[0]!
  expect(
    db
      .prepare('SELECT memory_id FROM tidy_operation_memories WHERE operation_id=?')
      .all(op.operationId),
  ).toEqual(expect.arrayContaining([{ memory_id: id }]))
  store.erase(id, note)
  expect(scan(db)).not.toContain(data.memories[0]!.summary)
  expect(scan(db)).not.toContain(data.memories[1]!.summary)
  expect(store.tidyChanges(50).items.find((item) => item.id === op.operationId)?.undoable).toBe(
    false,
  )
  expect(() => store.agentUndo(op.operationId, note)).toThrow('forgotten')
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
it('Forget removes an approval snapshot, and erase removes another read snapshot quoting the memory', () => {
  const { store, db } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id)
  store.propose(data)
  const approved = store.decideRead(
    job.id,
    { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
    0,
    note,
  )
  const id = approved.touched.memoryIds[0]!
  const next = store.enqueue(lane({ sessionId: 'ledger-lane' }), 'queued')
  store.propose(extraction(next.id, { computedRevision: store.knowledgeRevision() }))
  const rejected = store.decideRead(next.id, null, store.knowledgeRevision(), note)
  store.forget(id)
  expect(scan(db)).not.toContain(data.memories[0]!.summary)
  for (const operation of [approved.operationId, rejected.operationId])
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM tidy_operation_rows WHERE operation_id=?')
        .get(operation),
    ).toEqual({ n: 0 })
})
it('drops other read undo snapshots even when JSON escapes the erased sentence', () => {
  const { store, db } = fixture()
  const summary = 'Rina said "Ledger uses Kestrel".'
  const first = store.enqueue(lane(), 'queued')
  const data = extraction(first.id)
  data.memories[0]!.summary = summary
  data.evidence[0]!.text = summary
  data.memories[0]!.citations[0]!.quote = summary
  data.memories[0]!.links[0]!.citation.quote = summary
  store.propose(data)
  const approved = store.decideRead(
    first.id,
    { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
    0,
    note,
  )
  const second = store.enqueue(lane({ sessionId: 'ledger-lane' }), 'queued')
  store.propose({ ...data, jobId: second.id, computedRevision: store.knowledgeRevision() })
  const rejected = store.decideRead(second.id, null, store.knowledgeRevision(), note)
  store.erase(approved.touched.memoryIds[0]!, note)
  expect(
    db
      .prepare('SELECT COUNT(*) AS n FROM tidy_operation_rows WHERE operation_id=?')
      .get(rejected.operationId),
  ).toEqual({ n: 0 })
})
