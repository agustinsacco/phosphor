import { expect, it } from 'vitest'
import { BRAIN_RELATE_LIMIT_REFUSAL, BRAIN_RELATE_PER_RUN } from '@phosphor/shared/brain-agent'
import type { DatabaseSync } from 'node:sqlite'
import { fixture } from '../test-support'
import { dump, seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The cited memory says Rina works on Ledger.' }

/** `count` people, each named with Ledger by their own memory. */
function people(db: DatabaseSync, count: number): void {
  seed(db, count)
  db.prepare("INSERT INTO entities VALUES (?,'ledger','Ledger','project','',1,0,0)").run(count + 1)
  db.prepare('INSERT INTO mentions SELECT n,? FROM memories').run(count + 1)
}
/** What a link or importance change touches; derived counts are recomputed, not restored. */
function rows(db: DatabaseSync) {
  const all = dump(db)
  return ['memories', 'mentions', 'relations', 'relation_support', 'citations', 'evidence'].map(
    (table) => all[table],
  )
}
const links = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT memory,subject,predicate,object,label,valid_from,valid_to,stated_by FROM relations',
    )
    .all()
const input = (n: number) => ({
  subjectId: `rina-${n}`,
  predicate: 'works_on' as const,
  objectId: 'ledger',
  label: 'works on',
  memoryIds: [`memory-${n}`],
})

it('states a link on the cited memory as Brain Agent, and undo removes it exactly', () => {
  const { store, db } = fixture()
  people(db, 2)
  const before = rows(db)
  const operation = store.relate({ ...input(1), since: '2026-03-01' }, note)
  expect(links(db)).toEqual([
    {
      memory: 1,
      subject: 1,
      predicate: 'works_on',
      object: 3,
      label: 'works on',
      valid_from: Date.UTC(2026, 2, 1),
      valid_to: null,
      stated_by: 'agent',
    },
  ])
  expect(store.tidyChanges(5).items[0]).toMatchObject({ id: operation, kind: 'relate' })
  store.agentUndo(operation, note)
  expect(rows(db)).toEqual(before)
})
it('refuses links the cited memories do not support, changing nothing', () => {
  const { store, db } = fixture()
  people(db, 2)
  const before = rows(db)
  expect(() => store.relate({ ...input(1), memoryIds: [] }, note)).toThrow('Cite 1 to 8')
  expect(() => store.relate({ ...input(1), memoryIds: ['memory-2'] }, note)).toThrow(
    'One cited memory must name both',
  )
  expect(() => store.relate({ ...input(1), memoryIds: ['absent'] }, note)).toThrow(
    'Every cited memory must be current.',
  )
  expect(() => store.relate({ ...input(1), label: '' }, note)).toThrow("A link's wording")
  expect(() =>
    store.relate({ ...input(1), since: '2026-04-01', until: '2026-03-01' }, note),
  ).toThrow('cannot end before it starts')
  expect(() => store.relate({ ...input(1), objectId: 'rina-1' }, note)).toThrow()
  expect(rows(db)).toEqual(before)
  store.relate(input(1), note)
  expect(() => store.relate(input(1), note)).toThrow('These are already linked this way.')
})
it(`states at most ${BRAIN_RELATE_PER_RUN} links a run`, () => {
  const { store, db } = fixture()
  people(db, BRAIN_RELATE_PER_RUN + 1)
  const run = store.createRun()
  for (let n = 1; n <= BRAIN_RELATE_PER_RUN; n++) store.relate(input(n), { ...note, runId: run.id })
  expect(() => store.relate(input(BRAIN_RELATE_PER_RUN + 1), { ...note, runId: run.id })).toThrow(
    BRAIN_RELATE_LIMIT_REFUSAL,
  )
  expect(() => store.relate(input(BRAIN_RELATE_PER_RUN + 1), note)).not.toThrow()
})
it('states at most 20 links an hour outside a run', () => {
  const { store, db } = fixture()
  people(db, 21)
  for (let n = 1; n <= 20; n++) store.relate(input(n), note)
  expect(() => store.relate(input(21), note)).toThrow(BRAIN_RELATE_LIMIT_REFUSAL)
})
it('settles an unlinked pair it names, and refuses one that does not name both ends', () => {
  const { store, db } = fixture()
  people(db, 2)
  const offer = db.prepare(
    `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,detail,created_at,updated_at)
    VALUES (?,?,'unlinked','sweep','open','entity',?,'ledger','Named together.','{}',1,1)`,
  )
  offer.run('pair-1', 'link:1', 'rina-1')
  offer.run('pair-2', 'link:2', 'rina-2')
  expect(() => store.relate({ ...input(1), suggestionId: 'pair-2' }, note)).toThrow(
    'no longer available',
  )
  store.relate({ ...input(1), suggestionId: 'pair-1' }, note)
  expect(
    db
      .prepare('SELECT id,state FROM tidy_suggestions WHERE id IN (?,?) ORDER BY id')
      .all('pair-1', 'pair-2'),
  ).toEqual([
    { id: 'pair-1', state: 'applied' },
    { id: 'pair-2', state: 'open' },
  ])
})
it("edits a link's wording and dates and a memory's importance, each undone exactly", () => {
  const { store, db } = fixture()
  people(db, 1)
  store.relate(input(1), note)
  const relationId = String(db.prepare('SELECT n FROM relations').get()!.n)
  const before = rows(db)
  const edited = store.agentEdit(
    { kind: 'relation', relationId, label: 'leads the work on', until: '2026-05-01' },
    note,
  )
  expect(links(db)[0]).toMatchObject({
    label: 'leads the work on',
    valid_to: Date.UTC(2026, 4, 1),
  })
  expect(() =>
    store.agentEdit({ kind: 'relation', relationId, label: 'leads the work on' }, note),
  ).toThrow('This link already says that.')
  store.agentUndo(edited, note)
  expect(rows(db)).toEqual(before)
  const marked = store.agentEdit(
    { kind: 'importance', memoryId: 'memory-1', importance: 'high' },
    note,
  )
  expect(db.prepare("SELECT importance FROM memories WHERE id='memory-1'").get()).toEqual({
    importance: 2,
  })
  expect(() =>
    store.agentEdit({ kind: 'importance', memoryId: 'memory-1', importance: 'high' }, note),
  ).toThrow('already high')
  store.agentUndo(marked, note)
  expect(rows(db)).toEqual(before)
})
