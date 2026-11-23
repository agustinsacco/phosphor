import { expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from '../test-support'
import { dump } from './test-support'

/** Harbor, Rina Okafor (also "Rina") and Tom Lee, from one approved read. */
function brain() {
  const { store, db } = fixture()
  approve(store)
  const nodes = store.overview(300).nodes
  const id = (label: string) => nodes.find((node) => node.label === label)!.id
  return { store, db, harbor: id('Harbor'), rina: id('Rina Okafor'), tom: id('Tom Lee') }
}
const words = (db: ReturnType<typeof brain>['db'], n: string) =>
  db.prepare('SELECT rowid FROM entity_words WHERE entity_words MATCH ?').all(n)

it('describes a record, finds it by the new words, and undoes it exactly', () => {
  const { store, db, harbor } = brain()
  const before = dump(db)
  const revision = store.revision()
  expect(() => store.describe(harbor, 'Harbor billing system', revision - 1)).toThrow(
    'Brain changed',
  )
  for (const bad of ['', '   ', 'x'.repeat(161)])
    expect(() => store.describe(harbor, bad, revision)).toThrow('1 to 160 characters')
  const op = store.describe(harbor, '  Ledger payments gateway  ', revision)
  expect(store.revision()).toBe(revision + 1)
  expect(store.entity(harbor).entity.description).toBe('Ledger payments gateway')
  expect(words(db, 'gateway')).toHaveLength(1)
  expect(() => store.describe(harbor, 'Ledger payments gateway', store.revision())).toThrow(
    'already has this description',
  )
  expect(store.tidyChanges(20).items[0]).toMatchObject({
    id: op,
    kind: 'describe',
    summary: 'Changed the description of Harbor',
    who: 'you',
    undoable: true,
  })
  store.tidyUndo(op, store.revision())
  expect(dump(db)).toEqual(before)
  expect(words(db, 'gateway')).toHaveLength(0)
  expect(() => store.tidyUndo(op, store.revision())).toThrow('already undone')
})

it('removes an alias but never the label, and undo restores its name and trigrams', () => {
  const { store, db, rina } = brain()
  const before = dump(db)
  expect(() => store.removeName(rina, 'rina okafor', store.revision())).toThrow(
    'main name of this record',
  )
  expect(() => store.removeName(rina, 'Mara', store.revision())).toThrow('no other name "Mara"')
  const op = store.removeName(rina, 'RINA', store.revision())
  expect(store.entity(rina).entity.aliases).toEqual([])
  expect(store.tidyChanges(20).items[0]!.summary).toBe('Removed the name "Rina" from Rina Okafor')
  store.tidyUndo(op, store.revision())
  expect(dump(db)).toEqual(before)
  expect(store.entity(rina).entity.aliases).toEqual(['Rina'])
})

/** Tom Lee holds a Ledger engineer and a vendor's account rep. */
function twoToms() {
  const result = brain()
  const data = extraction('vendor')
  const citation = { evidence: 0, quote: 'Rina owns Harbor.' }
  const memory = (summary: string, links: boolean) => ({
    ...data.memories[0]!,
    summary,
    entities: [result.tom, result.harbor],
    links: links
      ? [{ subject: result.tom, predicate: 'uses' as const, object: result.harbor, citation }]
      : [],
    citations: [citation],
  })
  approve(result.store, {
    jobId: 'vendor',
    origin: { sessionId: 'northwind-lane', title: 'Northwind renewal' },
    entities: [],
    entityVectors: [],
    memories: [
      memory("Tom Lee is Northwind's account rep for Harbor.", true),
      memory('Tom Lee sends the Northwind renewal quote each March.', false),
    ],
    memoryVectors: [vector(), vector()],
  })
  const vendor = result.store
    .entityMemories(result.tom, {}, null)
    .memories.filter((m) => m.summary.includes('Northwind'))
    .map((m) => m.id)
  return { ...result, vendor }
}

it('splits memories, their mentions and links onto a new record and undoes it exactly', () => {
  const { store, db, tom, harbor, vendor } = twoToms()
  const before = dump(db)
  const target = { label: 'Tom Lee (Northwind)', kind: 'person' as const }
  const all = store.entityMemories(tom, {}, null).memories.map((m) => m.id)
  expect(() => store.split(tom, all, target, store.revision())).toThrow('is a rename')
  const other = store.entityMemories(harbor, {}, null).memories.find((m) => !all.includes(m.id))!
  expect(() => store.split(tom, [other.id], target, store.revision())).toThrow('must name Tom Lee')
  expect(() => store.split(tom, vendor, { ...target, label: ' ' }, store.revision())).toThrow(
    '1 to 80 characters',
  )
  const op = store.split(tom, vendor, target, store.revision())
  const created = store.tidyChanges(20).items[0]!
  expect(created).toMatchObject({
    kind: 'split',
    summary: 'Split Tom Lee (Northwind) from Tom Lee',
  })
  const node = store.overview(300).nodes.find((n) => n.label === 'Tom Lee (Northwind)')!
  expect(store.entity(node.id).entity).toMatchObject({ kind: 'person', aliases: [], memories: 2 })
  expect(store.entity(node.id).groups.map((g) => [g.predicate, g.direction])).toEqual([
    ['uses', 'out'],
  ])
  expect(store.entity(tom).entity.memories).toBe(1)
  expect(store.entity(tom).groups.map((g) => g.predicate)).toEqual(['works_on'])
  expect(store.memory(vendor[0]!).memory.entityIds).toContain(node.id)
  // The pair the owner just separated is never offered as "Same person or thing?".
  expect(store.suggestions('same_entity', null, 50).items).toEqual([])
  store.tidyUndo(op, store.revision())
  expect(dump(db)).toEqual(before)
  expect(() => store.entity(node.id)).toThrow('not found')
})

it('refuses to split off every current memory while a superseded mention remains', () => {
  const { store, db, tom, vendor } = twoToms()
  const target = { label: 'Tom Lee (Northwind)', kind: 'person' as const }
  const ledger = store.entityMemories(tom, {}, null).memories.find((m) => !vendor.includes(m.id))!
  db.prepare("UPDATE memories SET state='superseded' WHERE id=?").run(ledger.id)
  const current = store.entityMemories(tom, {}, null).memories.map((m) => m.id)
  expect(current.toSorted()).toEqual(vendor.toSorted())
  expect(() => store.split(tom, current, target, store.revision())).toThrow('is a rename')
})

it('leaves an unchosen superseded memory on the original, moves a chosen one, and undoes both', () => {
  const { store, db, tom, vendor } = twoToms()
  const target = { label: 'Tom Lee (Northwind)', kind: 'person' as const }
  // Newest first: the renewal quote, then the account rep (with its Harbor link).
  const [renewal, rep] = vendor as [string, string]
  db.prepare(
    "INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at) VALUES ('pair','memory:pair','conflict','sweep','open','memory',?,?,'These disagree.',1,1)",
  ).run(rep, renewal)
  store.applySuggestion('pair', { kind: 'replace', newerId: rep }, store.revision())
  expect(store.memory(renewal).memory.state).toBe('superseded')
  const before = dump(db)
  const names = (id: string) => store.memory(id).memory.entityIds
  const left = store.split(tom, [rep], target, store.revision())
  const created = store.overview(300).nodes.find((node) => node.label === target.label)!.id
  expect(names(renewal)).toContain(tom)
  expect(names(renewal)).not.toContain(created)
  store.tidyUndo(left, store.revision())
  expect(dump(db)).toEqual(before)
  const moved = store.split(tom, [rep, renewal], target, store.revision())
  const again = store.overview(300).nodes.find((node) => node.label === target.label)!.id
  expect(names(renewal)).toEqual(expect.arrayContaining([again]))
  expect(names(renewal)).not.toContain(tom)
  expect(store.entity(tom).entity.memories).toBe(1)
  store.tidyUndo(moved, store.revision())
  expect(dump(db)).toEqual(before)
})

it('keeps a later quote through a split undo, and refuses when later knowledge names the new record', () => {
  const { store, db, tom, harbor, vendor } = twoToms()
  const target = { label: 'Tom Lee (Northwind)', kind: 'person' as const }
  const op = store.split(tom, vendor, target, store.revision())
  const n = db.prepare('SELECT n FROM memories WHERE id=?').get(vendor[0]!)!.n as number
  db.prepare("INSERT INTO evidence VALUES (900,'northwind-lane','e-900','user','You',1,'q')").run()
  db.prepare("INSERT INTO citations VALUES (?,900,'Tom quotes in March.')").run(n)
  store.tidyUndo(op, store.revision())
  expect(store.memory(vendor[0]!).quotes.map((q) => q.quote)).toContain('Tom quotes in March.')

  const again = store.split(tom, vendor, target, store.revision())
  const created = store.overview(300).nodes.find((node) => node.label === target.label)!
  store.describe(harbor, 'Ledger payments gateway', store.revision())
  const harborMemory = store.entityMemories(harbor, {}, null).memories.at(-1)!
  db.prepare(
    'INSERT INTO mentions SELECT m.n,e.n FROM memories m, entities e WHERE m.id=? AND e.id=?',
  ).run(harborMemory.id, created.id)
  expect(() => store.tidyUndo(again, store.revision())).toThrow('Later changes')
})

it('takes the shared name off one record from a Tidy pair and closes the pair', () => {
  const { store, db, harbor } = brain()
  const kestrel = store.overview(300).nodes.find((n) => n.label === 'Tom Lee')!.id
  db.prepare("UPDATE entities SET label='Kestrel launch',kind='project' WHERE id=?").run(kestrel)
  db.prepare(
    "INSERT INTO entity_names(entity,name,folded) SELECT n,'Harbor','harbor' FROM entities WHERE id=?",
  ).run(kestrel)
  db.prepare(
    "INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at) VALUES ('pair','entity:pair','same_entity','sweep','open','entity',?,?,'Both use the name \"Harbor\".',1,1)",
  ).run(harbor, kestrel)
  expect(store.suggestion('pair')!.allowed).toEqual(['merge', 'unname'])
  const apply = (entityId: string, name: string) =>
    store.applySuggestion('pair', { kind: 'unname', entityId, name }, store.revision())
  expect(() => apply(harbor, 'Harbor')).toThrow('not a name these records share')
  expect(() => apply(kestrel, 'Ledger')).toThrow('not a name these records share')
  const op = apply(kestrel, 'harbor')!
  expect(store.entity(kestrel).entity.aliases).not.toContain('Harbor')
  expect(store.suggestion('pair')!.suggestion.state).toBe('dismissed')
  expect(store.tidyChanges(20).items[0]).toMatchObject({ kind: 'unname', suggestionId: 'pair' })
  store.tidyUndo(op, store.revision())
  expect(store.entity(kestrel).entity.aliases).toContain('Harbor')
  expect(store.suggestion('pair')!.suggestion.state).toBe('dismissed')
})

it('Forget erases an edit before-image that quotes the forgotten memory', () => {
  const { store, db, harbor } = brain()
  const memory = store.entityMemories(harbor, {}, null).memories[0]!
  const images = () =>
    db
      .prepare('SELECT before_image FROM tidy_operation_rows')
      .all()
      .map((row) => String(row.before_image))
      .join('\n')
  const kept = store.describe(harbor, 'Harbor invoices', store.revision())
  store.describe(harbor, memory.summary, store.revision())
  const quoting = store.describe(harbor, 'Ledger payments gateway', store.revision())
  expect(images()).toContain(memory.summary)
  store.forget(memory.id)
  expect(images()).not.toContain(memory.summary)
  expect(() => store.tidyUndo(quoting, store.revision())).toThrow('memory was forgotten')
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM tidy_operation_rows WHERE operation_id=?').get(kept),
  ).toEqual({ n: 1 })
})
