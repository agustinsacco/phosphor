import { expect, it } from 'vitest'
import { approve, extraction, fixture } from './test-support'

type Db = ReturnType<typeof fixture>['db']
function links(db: Db, memoryId: string) {
  return db
    .prepare(
      `SELECT s.label AS subject,r.predicate,o.label AS object,r.valid_to AS validTo,r.live,
      (SELECT COUNT(*) FROM relation_support WHERE relation=r.n) AS support
      FROM relations r JOIN memories m ON m.n=r.memory JOIN entities s ON s.n=r.subject
      JOIN entities o ON o.n=r.object WHERE m.id=? ORDER BY r.predicate,s.label`,
    )
    .all(memoryId)
}
function memoryId(db: Db, summary: string): string {
  return String(db.prepare('SELECT id FROM memories WHERE summary=?').get(summary)!.id)
}
function entityId(db: Db, label: string): string {
  return String(db.prepare('SELECT id FROM entities WHERE label=?').get(label)!.id)
}
/** A later read whose one claim supersedes `target`, naming the given links. */
function supersede(
  store: ReturnType<typeof fixture>['store'],
  db: Db,
  target: string,
  links: { subject: string; predicate: 'owns' | 'works_on'; object: string }[],
): string {
  const base = extraction('unused')
  const memory = base.memories[0]!
  approve(store, {
    jobId: 'leaf-2',
    origin: { sessionId: 'ledger-lane', title: 'Ledger billing' },
    entities: [],
    entityVectors: [],
    memoryVectors: [base.memoryVectors[0]!],
    memories: [
      {
        ...memory,
        summary: 'Harbor billing moved this week.',
        entities: links.flatMap((l) => [entityId(db, l.subject), entityId(db, l.object)]),
        links: links.map((l) => ({
          subject: entityId(db, l.subject),
          predicate: l.predicate,
          object: entityId(db, l.object),
          citation: { evidence: 0, quote: 'Rina owns Harbor.' },
          label: '',
        })),
        validFrom: 1700000000000,
        action: 'supersede',
        target,
      },
    ],
  })
  return memoryId(db, 'Harbor billing moved this week.')
}

it('a read that supersedes a memory carries its links the new memory does not contradict', () => {
  const { store, db } = fixture()
  approve(store)
  const old = memoryId(db, 'Rina Okafor owns the Harbor billing service.')
  const next = supersede(store, db, old, [
    { subject: 'Tom Lee', predicate: 'works_on', object: 'Harbor' },
  ])
  expect(links(db, next)).toEqual([
    {
      subject: 'Rina Okafor',
      predicate: 'owns',
      object: 'Harbor',
      validTo: null,
      live: 1,
      support: 1,
    },
    {
      subject: 'Tom Lee',
      predicate: 'works_on',
      object: 'Harbor',
      validTo: null,
      live: 1,
      support: 1,
    },
  ])
})

it('a read naming a new owner ends the old owner link at the new memory start', () => {
  const { store, db } = fixture()
  approve(store)
  const old = memoryId(db, 'Rina Okafor owns the Harbor billing service.')
  const next = supersede(store, db, old, [
    { subject: 'Tom Lee', predicate: 'owns', object: 'Harbor' },
  ])
  expect(links(db, next)).toEqual([
    {
      subject: 'Rina Okafor',
      predicate: 'owns',
      object: 'Harbor',
      validTo: 1700000000000,
      live: 1,
      support: 1,
    },
    { subject: 'Tom Lee', predicate: 'owns', object: 'Harbor', validTo: null, live: 1, support: 1 },
  ])
})
