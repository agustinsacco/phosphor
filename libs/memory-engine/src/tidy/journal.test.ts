import { expect, it } from 'vitest'
import { saveAndListMemories, fixture, vector } from '../test-support'
import { seed, dump } from './test-support'

it('raises four Rina records, merges them one by one, and undoes to identical source/index rows', () => {
  const { store, db } = fixture()
  seed(db)
  const before = dump(db)
  store.sweep('all')
  expect(store.suggestions('same_entity').items.length).toBeGreaterThanOrEqual(3)
  const operations = [2, 3, 4].map((n) => store.merge(`rina-${n}`, 'rina-1', store.revision()))
  expect(store.snapshot().counts.entities).toBe(1)
  for (const id of operations.reverse()) store.tidyUndo(id, store.revision())
  expect(dump(db)).toEqual(before)
  expect(store.snapshot().counts).toEqual({ entities: 4, memories: 4 })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(db.prepare('SELECT * FROM tidy_operation_rows').all()).toEqual([])
  store.sweep('all')
  store.sweep('all')
  expect(
    store.suggestions('same_entity').items.some((s) => s.subjects.some((v) => v.id === 'rina-1')),
  ).toBe(false)
})
it('undo leaves newly learned survivor facts in place and refuses a stale revision', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const op = store.merge('rina-2', 'rina-1', store.revision())
  const ids = saveAndListMemories(store, {
    entities: [],
    memories: [
      {
        summary: 'Rina reviews Kestrel.',
        type: 'fact',
        kind: 'reported',
        entities: ['rina-1'],
        links: [],
        branch: false,
        validFrom: null,
        validTo: null,
        action: 'add',
        target: null,
        reason: '',
        citations: [],
      },
    ],
    memoryVectors: [vector()],
    entityVectors: [],
  })
  expect(() => store.tidyUndo(op, 0)).toThrow('Brain changed')
  store.tidyUndo(op, store.revision())
  const learned = ids.find((id) => store.memory(id).memory.summary === 'Rina reviews Kestrel.')!
  expect(store.memory(learned).memory.entityIds).toEqual(['rina-1'])
  expect(store.memory('memory-2').memory.entityIds).toEqual(['rina-2'])
})
it('forget redacts only the moved memory from a merge journal; undo never resurrects it', () => {
  const { store, db } = fixture()
  seed(db, 3)
  const op = store.merge('rina-2', 'rina-1', store.revision())
  store.forget('memory-2')
  store.tidyUndo(op, store.revision())
  expect(() => store.memory('memory-2')).toThrow('not found')
  expect(store.memory('memory-1').memory.entityIds).toEqual(['rina-1'])
  expect(store.memory('memory-3').memory.entityIds).toEqual(['rina-3'])
  expect(
    db.prepare('SELECT * FROM tidy_operation_memories WHERE memory_id=?').all('memory-2'),
  ).toEqual([])
})
it('journals deduplicated relations and their support, including self-links removed by a merge', () => {
  const { store, db } = fixture()
  seed(db, 3)
  db.exec(`INSERT INTO mentions VALUES (1,2),(1,3);
    INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (1,1,1,'member_of',3,1,1),(2,1,2,'member_of',3,1,1),(3,1,1,'member_of',2,1,1);
    INSERT INTO relation_support VALUES (1,1,'Ledger'),(2,2,'Ledger'),(3,3,'Ledger');
    UPDATE entities SET memories=(SELECT COUNT(*) FROM mentions WHERE entity=entities.n),connections=(SELECT COUNT(*) FROM relations WHERE subject=entities.n)+(SELECT COUNT(*) FROM relations WHERE object=entities.n);`)
  const before = dump(db)
  const op = store.merge('rina-2', 'rina-1', store.revision())
  store.tidyUndo(op, store.revision())
  expect(dump(db)).toEqual(before)
})
it('refuses clean undo when later changes alter an affected source row, without partial restoration', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const op = store.merge('rina-2', 'rina-1', store.revision())
  db.exec("UPDATE entity_keys SET entity=1,value='changed' WHERE value='rina-2'")
  const before = dump(db)
  expect(() => store.tidyUndo(op, store.revision())).toThrow('cannot be cleanly undone')
  expect(dump(db)).toEqual(before)
})
