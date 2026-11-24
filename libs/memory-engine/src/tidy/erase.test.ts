import { expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { SuggestionTestStore as BrainStore } from './test-store'
import { fixture } from '../test-support'
import { seed, seedHistoricalVerdict } from './test-support'

const note = { runId: null, reason: 'The memories show the answer.' }

function chain() {
  const result = fixture()
  seed(result.db, 4)
  result.db.exec(`UPDATE mentions SET entity=1;
    UPDATE memories SET observed_at=1;
    UPDATE citations SET quote='Ledger copied evidence';
    UPDATE evidence SET entry_id='copied-entry',text='Ledger copied evidence';`)
  return result
}
function fold(store: BrainStore, source: string, survivor: string): string {
  store.sweep({ entityIds: [], memoryIds: [source, survivor] })
  const suggestion = store
    .suggestions('same_memory')
    .items.find((s) => [source, survivor].every((id) => s.subjects.some((v) => v.id === id)))!
  return store.resolve(suggestion.id, { kind: 'fold', survivorId: survivor }, note)!
}
function tidyText(db: DatabaseSync): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tidy_%'")
    .all()
  return tables
    .flatMap(({ name }) => {
      const columns = db
        .prepare(`PRAGMA table_info(${String(name)})`)
        .all()
        .filter((c) => c.type === 'TEXT')
      return columns.length
        ? db
            .prepare(`SELECT ${columns.map((c) => c.name).join(',')} FROM ${String(name)}`)
            .all()
            .map((r) => Object.values(r).join('\n'))
        : []
    })
    .join('\n')
}
it.each(['retained', 'undone', 'pruned'] as const)(
  'Forget erases folded ancestry when the intervening journal is %s',
  (mode) => {
    const { store, db } = chain()
    const first = fold(store, 'memory-1', 'memory-2')
    const second = fold(store, 'memory-2', 'memory-3')
    if (mode === 'undone') store.tidyUndo(second, store.revision())
    if (mode === 'pruned') {
      // Exercise real retention on the next journal write, without 200 unrelated graph mutations.
      const insert = db.prepare(
        "INSERT INTO tidy_operations VALUES (?,'merge',0,'Merged two people or things',999999,NULL,NULL,'entity','old','new')",
      )
      for (let i = 0; i < 199; i++) insert.run(`retained-${i}`)
      store.merge('rina-4', 'rina-3', store.revision())
      expect(db.prepare('SELECT id FROM tidy_operations WHERE id=?').get(first)).toBeUndefined()
    }
    store.forget('memory-3')
    expect(() => store.tidyUndo(first, store.revision())).toThrow(/no longer available|forgotten/)
    expect(() => store.tidyUndo(second, store.revision())).toThrow(
      /no longer available|forgotten|already undone/,
    )
    expect(() => store.memory('memory-1')).toThrow('not found')
    expect(tidyText(db)).not.toContain('Rina leads Ledger area 1.')
    expect(tidyText(db)).not.toContain('Rina leads Ledger area 2.')
    expect(tidyText(db)).not.toContain('Rina leads Ledger area 3.')
    expect(tidyText(db)).not.toContain('Ledger copied evidence')
  },
)
it('scrubs settled suggestions and moves an open flag along folds until Forget erases it', () => {
  const { store, db } = chain()
  const reason = 'Ledger flag evidence that must be forgotten'
  store.flag({
    memoryId: 'memory-1',
    problem: 'wrong',
    reason,
    title: 'Ledger flag title',
    sessionId: 'ledger-lane',
  })
  store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  const pair = store
    .suggestions('same_memory')
    .items.find((s) => s.subjects.some((v) => v.id === 'memory-1'))!
  seedHistoricalVerdict(db, pair.id, {
    kind: 'same',
    reason: 'Ledger verdict evidence that must be forgotten',
  })
  fold(store, 'memory-1', 'memory-2')
  expect(store.suggestions('flagged').items[0]).toMatchObject({
    reason,
    subjects: [{ id: 'memory-2' }],
  })
  expect(tidyText(db)).not.toContain('Ledger verdict evidence that must be forgotten')
  fold(store, 'memory-2', 'memory-3')
  store.forget('memory-3')
  for (const text of [
    reason,
    'Ledger flag title',
    'Ledger verdict evidence that must be forgotten',
  ])
    expect(tidyText(db)).not.toContain(text)
  store.reset()
  expect(db.prepare('SELECT * FROM tidy_operations').all()).toEqual([])
  expect(db.prepare('SELECT * FROM tidy_suggestions').all()).toEqual([])
})
function flagFirst(store: BrainStore): string {
  return store.flag({
    memoryId: 'memory-1',
    problem: 'wrong',
    reason: 'Rina leads Ledger area 1 is wrong; Tom Lee leads it',
    title: 'Harbor planning',
    sessionId: 'harbor-lane',
  }).suggestionId!
}
function flagRows(db: DatabaseSync) {
  return db
    .prepare("SELECT first_id,state FROM tidy_suggestions WHERE kind='flagged'")
    .all()
    .map((row) => ({ ...row }))
}
it('an undone fold puts the lane flag back on the memory the lane objected to', () => {
  const { store, db } = chain()
  flagFirst(store)
  const operation = fold(store, 'memory-1', 'memory-2')
  expect(flagRows(db)).toEqual([{ first_id: 'memory-2', state: 'open' }])
  store.tidyUndo(operation, store.revision())
  expect(flagRows(db)).toEqual([{ first_id: 'memory-1', state: 'open' }])
  expect(store.suggestions('flagged').items[0]!.subjects.map((s) => s.id)).toEqual(['memory-1'])
  store.forget('memory-1')
  expect(flagRows(db)).toEqual([])
  expect(tidyText(db)).not.toContain('Tom Lee leads it')
  expect(store.memory('memory-2').memory.state).toBe('active')
})
it('Forget of a memory erases the flag filed against it while the flag sits on another memory', () => {
  const { store, db } = chain()
  const flagged = flagFirst(store)
  // A flag can sit on a survivor while its memory is live: an earlier build left it there.
  db.prepare("UPDATE tidy_suggestions SET first_id='memory-2' WHERE id=?").run(flagged)
  store.forget('memory-1')
  expect(flagRows(db)).toEqual([])
  expect(tidyText(db)).not.toContain('Tom Lee leads it')
  expect(store.memory('memory-2').memory.state).toBe('active')
})
it('undoing a chain of folds newest first walks the flag back one memory at a time', () => {
  const { store, db } = chain()
  flagFirst(store)
  const first = fold(store, 'memory-1', 'memory-2')
  const second = fold(store, 'memory-2', 'memory-3')
  expect(flagRows(db)).toEqual([{ first_id: 'memory-3', state: 'open' }])
  store.tidyUndo(second, store.revision())
  expect(flagRows(db)).toEqual([{ first_id: 'memory-2', state: 'open' }])
  store.tidyUndo(first, store.revision())
  expect(flagRows(db)).toEqual([{ first_id: 'memory-1', state: 'open' }])
})
