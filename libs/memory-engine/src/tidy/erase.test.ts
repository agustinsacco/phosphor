import { expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { BrainStore } from '../types'
import { fixture } from '../test-support'
import { seed } from './test-support'

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
    .tidy('same_memory', null, 50)
    .items.find((s) => [source, survivor].every((id) => s.subjects.some((v) => v.id === id)))!
  return store.tidyApply(suggestion.id, { kind: 'fold', survivorId: survivor }, store.revision())!
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
    .tidy('same_memory', null, 50)
    .items.find((s) => s.subjects.some((v) => v.id === 'memory-1'))!
  store.recordVerdicts([
    {
      suggestionId: pair.id,
      model: 'made-up/model',
      verdict: { kind: 'same', reason: 'Ledger verdict evidence that must be forgotten' },
    },
  ])
  fold(store, 'memory-1', 'memory-2')
  expect(store.tidy('flagged', null, 50).items[0]).toMatchObject({
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
