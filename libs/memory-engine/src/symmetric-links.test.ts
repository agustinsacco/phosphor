/** `works_with` is stored once per pair, the lower entity number as subject, whatever writes it. */
import { expect, it } from 'vitest'
import { extraction, fixture, save, vector } from './test-support'
import type { Proposal, ProposalEntity, ProposalMemory } from './types'

const note = { runId: null, reason: 'The lane names two people called Tom Lee.' }
const NAMES = { tom: 'Tom Lee', mara: 'Mara Voss', rina: 'Rina Okafor' }
const person = (ref: keyof typeof NAMES): ProposalEntity => ({
  ...extraction('unused').entities[1]!,
  ref,
  label: NAMES[ref],
  aliases: [],
})
const worksWith = (summary: string, subject: string, object: string): ProposalMemory => ({
  ...extraction('unused').memories[0]!,
  summary,
  entities: [subject, object],
  links: [
    {
      subject,
      predicate: 'works_with',
      object,
      citation: { evidence: 0, quote: 'Rina owns Harbor.' },
      label: '',
    },
  ],
})
/** Tom, Mara and Rina exist in that order, and the first memory says Tom works with Rina. */
function people(): {
  store: ReturnType<typeof fixture>['store']
  db: ReturnType<typeof fixture>['db']
  ids: Record<string, string>
} {
  const { store, db } = fixture()
  save(store, {
    entities: [person('tom'), person('mara'), person('rina')],
    memories: [
      {
        ...extraction('unused').memories[0]!,
        summary: 'Tom Lee, Mara Voss and Rina Okafor met.',
        entities: ['tom', 'mara', 'rina'],
        links: [],
      },
    ],
    memoryVectors: [vector()],
    entityVectors: [vector(1), vector(0, 1), vector(0, 0, 1)],
  })
  const ids = Object.fromEntries(
    (
      db.prepare('SELECT id,label FROM entities ORDER BY n').all() as {
        id: string
        label: string
      }[]
    ).map((r) => [r.label, r.id]),
  )
  expect(Object.keys(ids)).toEqual(['Tom Lee', 'Mara Voss', 'Rina Okafor'])
  return { store, db, ids }
}
const links = (db: ReturnType<typeof fixture>['db']) =>
  db
    .prepare(
      `SELECT s.label AS s,o.label AS o,r.valid_to AS validTo,m.state FROM relations r
      JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory
      WHERE r.predicate='works_with' AND m.state='active' ORDER BY r.n`,
    )
    .all()
const read = (patch: Partial<Proposal>) => ({
  memoryVectors: [vector()],
  entities: [],
  entityVectors: [],
  ...patch,
})

it('saves a reader works_with link with the lower entity number as subject', () => {
  const { store, db, ids } = people()
  save(
    store,
    read({
      memories: [
        worksWith('Rina Okafor works with Tom Lee.', ids['Rina Okafor']!, ids['Tom Lee']!),
      ],
    }),
  )
  expect(links(db)).toEqual([{ s: 'Tom Lee', o: 'Rina Okafor', validTo: null, state: 'active' }])
})
it('never ends a works_with link because another person also works with one end', () => {
  const { store, db, ids } = people()
  save(
    store,
    read({
      memories: [
        worksWith('Tom Lee works with Rina Okafor.', ids['Tom Lee']!, ids['Rina Okafor']!),
      ],
    }),
  )
  const old = (
    db.prepare("SELECT id FROM memories WHERE summary LIKE 'Tom Lee works%'").get() as {
      id: string
    }
  ).id
  save(
    store,
    read({
      origin: { sessionId: 'ledger-lane', title: 'Ledger' },
      memories: [
        {
          ...worksWith('Mara Voss works with Rina Okafor.', ids['Mara Voss']!, ids['Rina Okafor']!),
          action: 'supersede',
          target: old,
        },
      ],
    }),
  )
  expect(links(db)).toEqual([
    { s: 'Mara Voss', o: 'Rina Okafor', validTo: null, state: 'active' },
    { s: 'Tom Lee', o: 'Rina Okafor', validTo: null, state: 'active' },
  ])
})
it('split keeps a moved works_with link with the lower entity number as subject', () => {
  const { store, db, ids } = people()
  save(
    store,
    read({
      memories: [
        worksWith('Tom Lee works with Rina Okafor.', ids['Tom Lee']!, ids['Rina Okafor']!),
      ],
    }),
  )
  const host = db.prepare("SELECT id FROM memories WHERE summary LIKE 'Tom Lee works%'").get() as {
    id: string
  }
  store.agentEdit(
    {
      kind: 'split',
      entityId: ids['Tom Lee']!,
      memoryIds: [host.id],
      label: 'Tom Lee (Kestrel)',
      entityKind: 'person',
    },
    note,
  )
  expect(
    db
      .prepare("SELECT subject<object AS ordered FROM relations WHERE predicate='works_with'")
      .all(),
  ).toEqual([{ ordered: 1 }])
  expect(links(db)).toEqual([
    { s: 'Rina Okafor', o: 'Tom Lee (Kestrel)', validTo: null, state: 'active' },
  ])
})
it('merge turns a moved works_with link round when the survivor has the higher number', () => {
  const { store, db, ids } = people()
  save(
    store,
    read({
      memories: [worksWith('Tom Lee works with Mara Voss.', ids['Tom Lee']!, ids['Mara Voss']!)],
    }),
  )
  store.agentEdit({ kind: 'merge', sourceId: ids['Tom Lee']!, targetId: ids['Rina Okafor']! }, note)
  expect(links(db)).toEqual([{ s: 'Mara Voss', o: 'Rina Okafor', validTo: null, state: 'active' }])
})
it('relate stores works_with with the lower number as subject and refuses the mirror', () => {
  const { store, db, ids } = people()
  const host = (db.prepare('SELECT id FROM memories').get() as { id: string }).id
  const link = (subjectId: string, objectId: string) => ({
    subjectId,
    predicate: 'works_with' as const,
    objectId,
    label: 'works closely with',
    since: null,
    until: null,
    memoryIds: [host],
  })
  store.relate(link(ids['Rina Okafor']!, ids['Tom Lee']!), note)
  expect(links(db)).toEqual([{ s: 'Tom Lee', o: 'Rina Okafor', validTo: null, state: 'active' }])
  expect(() => store.relate(link(ids['Tom Lee']!, ids['Rina Okafor']!), note)).toThrow(
    'already linked',
  )
  expect(links(db)).toHaveLength(1)
})
