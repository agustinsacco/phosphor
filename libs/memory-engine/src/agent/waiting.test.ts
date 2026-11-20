import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from '../tidy/test-support'
import { offer } from '../tidy/suggestions'

it('lists waiting kinds in decision order, oldest first, with bounded unchecked pairs and correct more', () => {
  const { store, db } = fixture()
  seed(db, 6)
  const ctx = { db, now: () => 100, id: () => `suggestion-${++sequence}` }
  let sequence = 0
  offer(ctx, 'memory', 'memory-1', 'memory-2', 'Possible repeat.', 'unchecked')
  offer(ctx, 'memory', 'memory-1', 'memory-3', 'Another possible repeat.', 'unchecked')
  offer(ctx, 'memory', 'memory-2', 'memory-3', 'These disagree.', 'conflict')
  offer(ctx, 'memory', 'memory-3', 'memory-4', 'These repeat.', 'same_memory')
  offer(ctx, 'entity', 'rina-1', 'rina-2', 'Shared names.', 'same_entity')
  offer(ctx, 'entity', 'rina-3', 'rina-4', 'Shared names, later.', 'same_entity')
  store.flag({
    memoryId: 'memory-6',
    problem: 'wrong',
    reason: 'Linear corrected this statement.',
    sessionId: 'ledger-lane',
    title: 'Ledger planning',
  })
  expect(store.waitingCounts()).toEqual({
    reads: 0,
    entities: 2,
    repeats: 1,
    conflicts: 1,
    flags: 1,
  })
  const first = store.waitingSuggestions(2, 1)
  expect(first.items.map((item) => item.kind)).toEqual(['same_entity', 'same_entity'])
  expect(first.more).toBe(4)
  expect(store.waitingSuggestions(20, 1).items.map((item) => item.kind)).toEqual([
    'same_entity',
    'same_entity',
    'same_memory',
    'conflict',
    'flagged',
    'possible_repeat',
  ])
  expect(store.waitingSuggestions(0, 1)).toEqual({ items: [], more: 6 })
  db.prepare(
    "UPDATE tidy_suggestions SET first_id='missing' WHERE subject_type='entity' AND first_id='rina-1'",
  ).run()
  expect(store.waitingCounts().entities).toBe(1)
  expect(store.waitingSuggestions(20, 0).more).toBe(0)
})
it('bounds and scrubs waiting labels and reasons and keeps unknown kinds out', () => {
  const { store, db } = fixture()
  seed(db, 2)
  let sequence = 0
  offer(
    { db, now: Date.now, id: () => `suggestion-${++sequence}` },
    'memory',
    'memory-1',
    'memory-2',
    'Bearer made-up-token-value',
  )
  db.prepare('UPDATE memories SET summary=? WHERE n=1').run('x'.repeat(1400))
  const result = store.waitingSuggestions(20, 40).items[0]!
  if (result.kind === 'read') throw new Error('Expected a suggestion')
  expect(result.subjects[0]!.label).toHaveLength(1200)
  expect(result.reason).not.toContain('made-up-token-value')
  expect(store.agentSuggestion(result.suggestionId)?.suggestion.reason).not.toContain(
    'made-up-token-value',
  )
  db.prepare("UPDATE tidy_suggestions SET kind='future-kind'").run()
  expect(store.waitingSuggestions(20, 40)).toEqual({ items: [], more: 0 })
})
