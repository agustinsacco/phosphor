import { expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { fixture } from '../test-support'
import { seed } from './test-support'
import type { SuggestionTestStore } from './test-store'

const note = { runId: null, reason: 'The memories show no lasting relationship.' }

function pass(store: SuggestionTestStore): number {
  let result = store.sweep('all')
  let unlinked = result.unlinked
  while (result.coverage.phase !== 'done') {
    result = store.sweep('all')
    unlinked += result.unlinked
  }
  return unlinked
}
function unlinked(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT first_id,second_id,state,reason,detail FROM tidy_suggestions WHERE kind='unlinked'",
    )
    .all()
    .map((row) => ({ ...row, state: String(row.state), detail: JSON.parse(String(row.detail)) }))
}

it('offers people named together in two memories with no link, once, and never again after keep', () => {
  const { store, db } = fixture()
  seed(db, 4)
  // Rina 1 and 2 share two memories; 1 and 3 share one; 3 and 4 share two but are linked.
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1),(3,1),(3,4),(4,3)')
  db.exec(
    "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (3,3,'reports_to',4,1,3)",
  )
  expect(pass(store)).toBe(1)
  expect(unlinked(db)).toEqual([
    {
      first_id: 'rina-1',
      second_id: 'rina-2',
      state: 'open',
      reason: 'Named together in 2 memories; no link says how they relate.',
      detail: { kind: 'unlinked', shared: 2, memoryIds: ['memory-2', 'memory-1'] },
    },
  ])
  expect(store.waitingCounts().unlinked).toBe(1)
  const id = String(db.prepare("SELECT id FROM tidy_suggestions WHERE kind='unlinked'").get()!.id)
  const operation = store.resolve(id, { kind: 'keep' }, note)
  expect(store.tidyChanges(5).items[0]).toMatchObject({
    id: operation,
    summary: 'No lasting link: Rina Okafor and Rina Okafor',
  })
  expect(pass(store)).toBe(0)
  expect(unlinked(db).map((row) => row.state)).toEqual(['dismissed'])
})
it('offers no pair whose kinds no link allows, and none through an ended memory', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
  db.exec('UPDATE memories SET valid_to=1 WHERE n=2')
  expect(pass(store)).toBe(0)
  db.exec('UPDATE memories SET valid_to=NULL WHERE n=2')
  db.exec("UPDATE entities SET kind='concept'")
  expect(pass(store)).toBe(0)
})
it('offers a pair as soon as the memories that name it are swept, before any full pass', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
  const memoryIds = db
    .prepare('SELECT id FROM memories ORDER BY n')
    .all()
    .map((row) => String(row.id))
  expect(store.sweep({ entityIds: [], memoryIds }).unlinked).toBe(1)
  expect(store.waitingCounts().unlinked).toBe(1)
})
it('offers only pairs the swept memories name; the full pass finds the rest', () => {
  const { store, db } = fixture()
  seed(db, 4)
  // 1 and 2 share memories 1 and 2; 3 and 4 share memories 3 and 4. Only memory 1 is swept.
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1),(3,4),(4,3)')
  expect(store.sweep({ entityIds: [], memoryIds: ['memory-1'] }).unlinked).toBe(1)
  expect(unlinked(db)).toMatchObject([{ first_id: 'rina-1', second_id: 'rina-2' }])
  expect(pass(store)).toBe(1)
})
it('clears an open pair once a link explains it, freeing its slot without a keep', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
  expect(pass(store)).toBe(1)
  store.relate(
    {
      subjectId: 'rina-1',
      predicate: 'works_with',
      objectId: 'rina-2',
      label: 'works closely with',
      since: null,
      until: null,
      memoryIds: ['memory-1'],
    },
    note,
  )
  expect(store.waitingCounts().unlinked).toBe(0)
  expect(unlinked(db).map((row) => row.state)).toEqual(['cleared'])
})
it('keeps at most 40 pairs waiting and offers the next once one is answered', () => {
  const { store, db } = fixture()
  seed(db, 84)
  // Records 2k+1 and 2k+2 share memories 2k+1 and 2k+2: 42 pairs.
  const pairs = db.prepare('INSERT INTO mentions VALUES (?,?)')
  for (let k = 0; k < 42; k++) {
    pairs.run(2 * k + 1, 2 * k + 2)
    pairs.run(2 * k + 2, 2 * k + 1)
  }
  expect(pass(store)).toBe(40)
  expect(store.waitingCounts().unlinked).toBe(40)
  expect(pass(store)).toBe(0)
  const id = String(
    db.prepare("SELECT id FROM tidy_suggestions WHERE kind='unlinked' LIMIT 1").get()!.id,
  )
  store.resolve(id, { kind: 'keep' }, note)
  expect(pass(store)).toBe(1)
  expect(store.waitingCounts().unlinked).toBe(40)
})
it('offers no pair with a hub: Rina 1 links to 201 others', () => {
  const { store, db } = fixture()
  seed(db, 203)
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
  const link = db.prepare(
    "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,1,'works_with',?,1,1)",
  )
  for (let n = 3; n <= 203; n++) link.run(n, n)
  expect(pass(store)).toBe(0)
  db.exec('DELETE FROM relations WHERE object=203')
  expect(pass(store)).toBe(1)
})
it('counts an ended relationship as explaining the pair', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
  db.exec(
    "INSERT INTO relations(memory,subject,predicate,object,live,observed_at,valid_to) VALUES (1,1,'reports_to',2,1,1,2)",
  )
  expect(pass(store)).toBe(0)
})
