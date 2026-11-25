import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from './test-support'

const note = { runId: null, reason: 'The memories show the answer.' }

it('offers a one-word person/full-name pair and shared aliases, never a cross-kind namesake', () => {
  const { store, db } = fixture()
  seed(db, 4)
  db.exec(`UPDATE entities SET label='Rina' WHERE n=1;
    UPDATE entity_names SET name='Rina',folded='rina' WHERE entity=1;
    UPDATE entity_words SET text='Rina' WHERE rowid=1;
    UPDATE entities SET kind='organization' WHERE n=3;
    UPDATE entities SET label='Mara Voss' WHERE n=4;
    UPDATE entity_names SET name='Mara Voss',folded='mara voss' WHERE entity=4;
    INSERT INTO entity_names VALUES (5,4,'Rina Okafor','rina okafor');
    UPDATE entity_words SET text='Mara Voss Rina Okafor' WHERE rowid=4;`)
  store.sweep('all')
  const pairs = store
    .suggestions('same_entity')
    .items.map((s) => s.subjects.map((v) => v.id).sort())
  expect(pairs).toContainEqual(['rina-1', 'rina-2'])
  expect(pairs).toContainEqual(['rina-2', 'rina-4'])
  expect(pairs.flat()).not.toContain('rina-3')
  expect(store.snapshot().counts.entities).toBe(4)
})

it('names shared full-name evidence even when a one-word alias is visited first', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec(
    "UPDATE entity_names SET name='Rina',folded='rina' WHERE entity=1; INSERT INTO entity_names VALUES (3,1,'Rina Okafor','rina okafor')",
  )
  store.sweep({ entityIds: ['rina-1', 'rina-2'], memoryIds: [] })
  expect(store.suggestions('same_entity').items.map((s) => s.reason)).toEqual([
    'Both are named "Rina Okafor".',
  ])
})

it('names one-word and full-name evidence rather than quoting memory sentences', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec(
    "UPDATE entities SET label='Rina' WHERE n=1; UPDATE entity_names SET name='Rina',folded='rina' WHERE entity=1; UPDATE entity_words SET text='Rina' WHERE rowid=1",
  )
  store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
  expect(store.suggestions('same_entity').items.map((s) => s.reason)).toEqual([
    '"Rina" is part of the name "Rina Okafor".',
  ])
})

it('names the shared alias of two differently named things', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec(
    "UPDATE entities SET kind='component',label=CASE n WHEN 1 THEN 'Ledger service' ELSE 'Ledger backend' END; UPDATE entity_names SET name=CASE entity WHEN 1 THEN 'Ledger service' ELSE 'Ledger backend' END,folded=CASE entity WHEN 1 THEN 'ledger service' ELSE 'ledger backend' END; INSERT INTO entity_names VALUES (3,1,'Ledger API','ledger api'),(4,2,'Ledger API','ledger api')",
  )
  store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
  expect(store.suggestions('same_entity').items.map((s) => s.reason)).toEqual([
    'Both use the name "Ledger API".',
  ])
})

it('settles four records in three merges even when the first merge removes the cluster centre', () => {
  const { store, db } = fixture()
  seed(db, 4)
  store.sweep('all')
  const pairs = () =>
    store.suggestions('same_entity').items.map((s) => s.subjects.map((v) => v.id).sort())
  const merge = (source: string) => {
    const suggestion = store
      .suggestions('same_entity')
      .items.find(
        (s) => s.subjects.some((v) => v.id === source) && s.subjects.some((v) => v.id === 'rina-4'),
      )!
    expect(suggestion).toBeDefined()
    return store.resolve(suggestion.id, { kind: 'merge', survivorId: 'rina-4' }, note)!
  }
  merge('rina-1')
  expect(pairs()).toContainEqual(['rina-2', 'rina-4'])
  expect(pairs()).toContainEqual(['rina-3', 'rina-4'])
  expect(pairs().flat()).not.toContain('rina-1')
  merge('rina-2')
  expect(pairs()).toEqual([['rina-3', 'rina-4']])
  const last = merge('rina-3')
  expect(pairs()).toEqual([])
  store.tidyUndo(last, store.revision())
  expect(pairs()).toEqual([])
  store.sweep({ entityIds: ['rina-3', 'rina-4'], memoryIds: [] })
  expect(pairs()).toEqual([])
})
