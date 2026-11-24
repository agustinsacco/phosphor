import { expect, it } from 'vitest'
import { fixture, save } from './test-support'
import { seed } from './tidy/test-support'
import { offer } from './tidy/suggestions'

it('counts recalls and flags without a revision change', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const revisions = () => [store.revision(), store.knowledgeRevision()]
  const before = revisions()
  store.recordRecall(['memory-1', 'memory-1', 'memory-2', 'absent'], 500)
  store.recordRecall(['memory-1'], 400)
  expect(revisions()).toEqual(before)
  store.flag({
    memoryId: 'memory-2',
    problem: 'wrong',
    reason: 'Linear says otherwise.',
    sessionId: 'ledger-lane',
    title: 'Ledger planning',
  })
  expect(db.prepare('SELECT * FROM memory_use ORDER BY memory').all()).toEqual([
    { memory: 1, recalled: 2, last_recalled: 500, flagged: 0 },
    { memory: 2, recalled: 1, last_recalled: 500, flagged: 1 },
  ])
  expect(() => store.recordRecall(['memory-1'], -1)).toThrow('Invalid Brain recall time.')
})
it('changes the waiting signature only when what waits changes', () => {
  const { store, db } = fixture()
  seed(db, 3)
  const empty = store.waitingSignature()
  expect(store.waitingSignature()).toBe(empty)
  offer(
    { db, now: () => 2000, id: () => 'pair-1' },
    'entity',
    'rina-1',
    'rina-2',
    'Shared names.',
    'same_entity',
  )
  const one = store.waitingSignature()
  expect(one).not.toBe(empty)
  expect(store.waitingSignature()).toBe(one)
  store.resolve('pair-1', { kind: 'keep' }, { runId: null, reason: 'Different teams.' })
  expect(store.waitingSignature()).not.toBe(one)
})
it('raises the automatic fold notice for folds only, never for a saved read (F11)', () => {
  const { store } = fixture()
  save(store)
  expect(store.tidySummary()).toEqual({ automaticFolds: 0, newestAutomaticFoldAt: null })
  expect(store.tidyChanges(5).items[0]).toMatchObject({ kind: 'read', who: 'automatic' })
})
