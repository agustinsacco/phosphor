import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed, dump, seedHistoricalVerdict } from './test-support'

function shared(count = 2) {
  const result = fixture()
  seed(result.db, count, true)
  result.db.exec(
    'UPDATE mentions SET entity=1; UPDATE entities SET memories=CASE WHEN n=1 THEN 2 ELSE 0 END;',
  )
  return result
}
it('automatically folds exact repeats, restores every source row, and remembers undo across sweeps', () => {
  const { store, db } = shared()
  const before = dump(db)
  const found = store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(found.folded).toBe(1)
  expect(store.snapshot().counts.memories).toBe(1)
  expect(store.memory('memory-1').quotes).toHaveLength(2)
  expect(store.tidySummary()).toMatchObject({ automaticFolds: 1 })
  store.tidyUndo(found.operationIds[0]!, store.revision())
  expect(dump(db)).toEqual(before)
  expect(store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] }).folded).toBe(0)
  store.sweep('all')
  expect(store.sweep('all').folded).toBe(0)
  expect(store.snapshot().counts.memories).toBe(2)
  expect(store.suggestions('same_memory', null, 20).items).toEqual([])
})
it('only suggests near repeats, leaves two supporting memories alone, and never folds branches', () => {
  const { store, db } = shared()
  db.exec(
    "UPDATE memories SET summary='Rina is responsible for Ledger.' WHERE n=2; INSERT INTO mentions VALUES (1,2),(2,2); INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (1,1,1,'member_of',2,1,1),(2,2,1,'member_of',2,1,2);",
  )
  const result = store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(result.folded).toBe(0)
  expect(store.suggestions('same_memory', null, 20).items).toHaveLength(1)
  expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 2 })
  const item = store.suggestions('same_memory', null, 20).items[0]!
  store.dismissSuggestion(item.id, store.revision())
  store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(store.suggestions('same_memory', null, 20).items).toEqual([])
  db.exec("UPDATE memories SET summary='Rina leads Ledger.',branch='kestrel' WHERE n=2")
  expect(store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] }).folded).toBe(0)
  expect(store.snapshot().counts.memories).toBe(2)
})
it('fold transfers supported links and deduplicates copied quotes by entry identity', () => {
  const { store, db } = shared()
  db.exec(
    "INSERT INTO mentions VALUES (1,2),(2,2); INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (1,1,1,'member_of',2,1,1),(2,2,1,'member_of',2,1,2); INSERT INTO relation_support VALUES (1,1,'Rina leads Ledger.'),(2,2,'Rina leads Ledger.'); UPDATE evidence SET entry_id='entry-1' WHERE n=2; UPDATE entities SET memories=2,connections=1;",
  )
  const before = dump(db)
  const result = store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(result.folded).toBe(1)
  expect(store.memory('memory-1').quotes).toHaveLength(1)
  expect(db.prepare('SELECT COUNT(*) AS n FROM relation_support').get()).toEqual({ n: 1 })
  store.tidyUndo(result.operationIds[0]!, store.revision())
  expect(dump(db)).toEqual(before)
})
it.each(['dispute', 'replace'] as const)('journals and undoes the %s action', (kind) => {
  const { store, db } = shared()
  db.exec(
    "UPDATE memories SET summary='Rina no longer leads Ledger.' WHERE n=2; UPDATE memory_words SET summary='Rina no longer leads Ledger.' WHERE rowid=2",
  )
  store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  // "no longer" makes the near pair a possible disagreement, not a repeat.
  const suggestion = store.suggestions('conflict', null, 20).items[0]!
  expect(suggestion.reason).toBe('These may disagree.')
  seedHistoricalVerdict(db, suggestion.id, {
    kind: 'conflict',
    reason: 'These statements disagree.',
  })
  const before = dump(db)
  const op = store.applySuggestion(
    suggestion.id,
    kind === 'dispute' ? { kind } : { kind, newerId: 'memory-2' },
    store.revision(),
  )!
  expect(store.memory('memory-1').memory.state).toBe(kind === 'dispute' ? 'disputed' : 'superseded')
  store.tidyUndo(op, store.revision())
  expect(dump(db)).toEqual(before)
  expect(store.suggestions(null, null, 20).items).toEqual([])
})
it('rejects folding different validity periods and a stale apply without modifying rows', () => {
  const { store, db } = shared()
  db.exec('UPDATE memories SET valid_from=30 WHERE n=2')
  store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  const suggestion = store.suggestions('same_memory', null, 20).items[0]!
  const before = dump(db)
  expect(() =>
    store.applySuggestion(suggestion.id, { kind: 'fold', survivorId: 'memory-1' }, 0),
  ).toThrow('Brain changed')
  expect(() =>
    store.applySuggestion(
      suggestion.id,
      { kind: 'fold', survivorId: 'memory-1' },
      store.revision(),
    ),
  ).toThrow('validity dates')
  expect(dump(db)).toEqual(before)
})

it('can suggest near repeats among disputed memories but never folds disputed exact sentences', () => {
  const { store, db } = shared()
  db.exec(
    "UPDATE memories SET state='disputed'; UPDATE memories SET summary='Rina is responsible for Ledger.' WHERE n=2",
  )
  const result = store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(result.folded).toBe(0)
  expect(store.suggestions('same_memory', null, 20).items).toHaveLength(1)
})
