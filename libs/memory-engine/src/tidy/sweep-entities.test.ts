import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from './test-support'

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
    .tidy('same_entity', null, 50)
    .items.map((s) => s.subjects.map((v) => v.id).sort())
  expect(pairs).toContainEqual(['rina-1', 'rina-2'])
  expect(pairs).toContainEqual(['rina-2', 'rina-4'])
  expect(pairs.flat()).not.toContain('rina-3')
  expect(store.snapshot().counts.entities).toBe(4)
})
