import { expect, it } from 'vitest'
import { approve, extraction, fixture } from '../test-support'
import { pairKey } from './suggestions'

type Db = ReturnType<typeof fixture>['db']
const note = { runId: null, reason: 'The newer memory says what changed.' }
function links(db: Db, memoryId: string) {
  return db
    .prepare(
      `SELECT s.label AS subject,r.predicate,o.label AS object,r.valid_to AS validTo,r.live
      FROM relations r JOIN memories m ON m.n=r.memory JOIN entities s ON s.n=r.subject
      JOIN entities o ON o.n=r.object WHERE m.id=? ORDER BY r.predicate,s.label`,
    )
    .all(memoryId)
}
function memoryId(db: Db, summary: string): string {
  return String(db.prepare('SELECT id FROM memories WHERE summary=?').get(summary)!.id)
}
function conflict(db: Db, first: string, second: string): string {
  db.prepare(
    `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at)
    VALUES ('conflict-1',?,'conflict','sweep','open','memory',?,?,'These may disagree.',1,1)`,
  ).run(pairKey('memory', first, second), first, second)
  return 'conflict-1'
}

it('replace carries the older memory links the newer one does not contradict', () => {
  const { store, db } = fixture()
  approve(store)
  const older = memoryId(db, 'Rina Okafor owns the Harbor billing service.')
  const newer = memoryId(db, 'Tom Lee maintains the Harbor invoice archive.')
  const operation = store.resolve(
    conflict(db, newer, older),
    { kind: 'replace', newerId: newer },
    note,
  )
  expect(links(db, newer)).toEqual([
    { subject: 'Rina Okafor', predicate: 'owns', object: 'Harbor', validTo: null, live: 1 },
    { subject: 'Tom Lee', predicate: 'works_on', object: 'Harbor', validTo: null, live: 1 },
  ])
  store.agentUndo(operation, note)
  expect(links(db, newer)).toEqual([
    { subject: 'Tom Lee', predicate: 'works_on', object: 'Harbor', validTo: null, live: 1 },
  ])
  expect(links(db, older)).toEqual([
    { subject: 'Rina Okafor', predicate: 'owns', object: 'Harbor', validTo: null, live: 1 },
  ])
})

it('replace ends a link the newer memory contradicts at the newer memory start', () => {
  const { store, db } = fixture()
  const base = extraction('unused')
  approve(store, {
    memories: [
      base.memories[0]!,
      {
        ...base.memories[1]!,
        summary: 'Tom Lee owns the Harbor billing service now.',
        links: [{ ...base.memories[1]!.links[0]!, predicate: 'owns' }],
      },
    ],
  })
  const older = memoryId(db, 'Rina Okafor owns the Harbor billing service.')
  const newer = memoryId(db, 'Tom Lee owns the Harbor billing service now.')
  store.resolve(conflict(db, newer, older), { kind: 'replace', newerId: newer }, note)
  expect(links(db, newer)).toEqual([
    {
      subject: 'Rina Okafor',
      predicate: 'owns',
      object: 'Harbor',
      validTo: 1700000000000,
      live: 1,
    },
    { subject: 'Tom Lee', predicate: 'owns', object: 'Harbor', validTo: null, live: 1 },
  ])
})
