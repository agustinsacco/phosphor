import { expect, it } from 'vitest'
import { emptyBrainTidyCoverage } from '@phosphor/shared/brain-tidy'
import { approve, extraction, fixture, vector } from '../test-support'
import { encodeVector } from '../vectors'
import { seed } from './test-support'

function namesake(kinds: [string, string]) {
  const result = fixture()
  seed(result.db, 2)
  result.db
    .prepare(
      "UPDATE entities SET label='Northwind',kind=CASE n WHEN 1 THEN ? ELSE ? END; UPDATE entity_names SET name='Northwind',folded='northwind'",
    )
    .run(...kinds)
  result.db.exec("UPDATE entity_names SET name='Northwind',folded='northwind'")
  return result
}
it('pairs one name stored as a component and as an organization', () => {
  const { store } = namesake(['component', 'organization'])
  store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
  expect(store.tidy('same_entity', null, 20).items.map((item) => item.reason)).toEqual([
    'Same name, stored as a component and as an organization.',
  ])
})
it.each([
  ['person', 'organization'],
  ['project', 'event'],
] as const)('never pairs a %s and an %s by name alone', (...kinds) => {
  const { store } = namesake(kinds)
  store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
  expect(store.tidy('same_entity', null, 20).items).toEqual([])
})

function memoryPair(first: string, second: string, similarity = 0.86) {
  const result = fixture()
  seed(result.db, 2)
  result.db.exec('UPDATE mentions SET entity=1')
  const summary = result.db.prepare('UPDATE memories SET summary=? WHERE n=?')
  summary.run(first, 1)
  summary.run(second, 2)
  const update = result.db.prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
  update.run(encodeVector(vector(1, 0)), 1)
  update.run(encodeVector(vector(similarity, Math.sqrt(1 - similarity ** 2))), 2)
  return result
}
it.each([
  [
    'Rina wants short bold headers in Ledger notes.',
    'Rina wants no bold formatting in Ledger notes.',
  ],
  ['Ledger deploys on Fridays.', 'Ledger never deploys on Fridays.'],
  ['Harbor ships with the archive.', 'Harbor ships without the archive.'],
  ['Use Kestrel for invoices.', 'Use Ledger instead of Kestrel for invoices.'],
])('raises a near pair that differs by a negation as a possible disagreement', (a, b) => {
  const { store } = memoryPair(a, b)
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  expect(store.tidy('same_memory', null, 20).items).toEqual([])
  expect(store.tidy('conflict', null, 20).items.map((item) => item.reason)).toEqual([
    'These may disagree.',
  ])
})
it('keeps a near pair with the same polarity as a repeat', () => {
  const { store } = memoryPair(
    'Ledger never deploys on Fridays.',
    'Ledger does not deploy on Fridays.',
  )
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  expect(store.tidy('same_memory', null, 20).items).toHaveLength(1)
})

it('keeps the model reason on the suggestion a fold applies', () => {
  const { store } = memoryPair('Rina leads Ledger.', 'Rina is the Ledger lead.')
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  const [item] = store.tidy('same_memory', null, 20).items
  store.recordVerdicts([
    {
      suggestionId: item!.id,
      model: 'example/reader',
      verdict: { kind: 'same', reason: 'Both say Rina leads Ledger.' },
    },
  ])
  store.tidyApply(item!.id, { kind: 'fold', survivorId: 'memory-1' }, store.revision())
  expect(store.tidySuggestion(item!.id)!.suggestion).toMatchObject({
    state: 'applied',
    reason: 'Both say Rina leads Ledger.',
    verdict: { kind: 'same', reason: 'Both say Rina leads Ledger.' },
  })
})

it('reports which verdicts it recorded and which pairs the owner settled meanwhile', () => {
  const { store } = memoryPair('Rina leads Ledger.', 'Rina is the Ledger lead.')
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  const [item] = store.tidy('same_memory', null, 20).items
  store.tidyDismiss(item!.id, store.revision())
  const verdict = { kind: 'same' as const, reason: 'Same assertion.' }
  expect(
    store.recordVerdicts([
      { suggestionId: item!.id, model: 'example/reader', verdict },
      { suggestionId: 'forgotten', model: 'example/reader', verdict },
    ]),
  ).toEqual({ recorded: 0, settled: 2 })
})

it('shows only public coverage fields, with current totals once a pass is done', () => {
  const { store } = fixture()
  approve(store)
  while (store.sweep('all').coverage.phase !== 'done');
  const coverage = store.tidy(null, null, 20).coverage
  expect(Object.keys(coverage).sort()).toEqual(Object.keys(emptyBrainTidyCoverage()).sort())
  const data = extraction('later')
  approve(store, {
    jobId: 'later',
    memories: [{ ...data.memories[0]!, summary: 'Rina archives Harbor invoices weekly.' }],
    memoryVectors: [vector(0, 0, 1)],
  })
  const { counts } = store.snapshot()
  expect(counts.memories).toBeGreaterThan(coverage.totalMemories)
  expect(store.tidy(null, null, 20).coverage).toMatchObject({
    phase: 'done',
    totalMemories: counts.memories,
    totalEntities: counts.entities,
  })
})

it('refuses a stale dispute with a plain sentence and writes nothing', () => {
  const { store } = memoryPair('Rina leads Ledger.', 'Mara Voss leads Ledger.')
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  const [item] = store.tidy('same_memory', null, 20).items
  const revision = store.revision()
  store.recordVerdicts([
    {
      suggestionId: item!.id,
      model: 'example/reader',
      verdict: { kind: 'conflict', reason: 'Two different leads.' },
    },
  ])
  expect(() => store.tidyApply(item!.id, { kind: 'dispute' }, revision)).toThrow(
    'Brain changed; refresh Tidy and try again.',
  )
  expect(store.tidyChanges(20).items).toEqual([])
  expect(store.tidySuggestion(item!.id)!.suggestion.state).toBe('open')
  expect(store.memory('memory-1').memory.state).toBe('active')
  const op = store.tidyApply(item!.id, { kind: 'dispute' }, store.revision())
  expect(store.tidyChanges(20).items.map((change) => [change.id, change.kind])).toEqual([
    [op, 'dispute'],
  ])
})
