import { expect, it } from 'vitest'
import { emptyBrainTidyCoverage } from '@phosphor/shared/brain-tidy'
import { saveAndListMemories, extraction, fixture, vector } from '../test-support'
import { encodeVector } from '../vectors'
import { seed, seedHistoricalVerdict } from './test-support'

const note = { runId: null, reason: 'The memories show the answer.' }

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
  expect(store.suggestions('same_entity').items.map((item) => item.reason)).toEqual([
    'Same name, stored as a component and as an organization.',
  ])
})
it.each([
  ['person', 'organization'],
  ['project', 'event'],
] as const)('never pairs a %s and an %s by name alone', (...kinds) => {
  const { store } = namesake(kinds)
  store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
  expect(store.suggestions('same_entity').items).toEqual([])
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
  expect(store.suggestions('same_memory').items).toEqual([])
  expect(store.suggestions('conflict').items.map((item) => item.reason)).toEqual([
    'These may disagree.',
  ])
})
it('keeps a near pair with the same polarity as a repeat', () => {
  const { store } = memoryPair(
    'Ledger never deploys on Fridays.',
    'Ledger does not deploy on Fridays.',
  )
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  expect(store.suggestions('same_memory').items).toHaveLength(1)
})

it('keeps the model reason on the suggestion a fold applies', () => {
  const { store, db } = memoryPair('Rina leads Ledger.', 'Rina is the Ledger lead.')
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  const [item] = store.suggestions('same_memory').items
  seedHistoricalVerdict(db, item!.id, { kind: 'same', reason: 'Both say Rina leads Ledger.' })
  store.resolve(item!.id, { kind: 'fold', survivorId: 'memory-1' }, note)
  expect(store.agentSuggestion(item!.id)!.suggestion).toMatchObject({
    state: 'applied',
    reason: 'Both say Rina leads Ledger.',
    verdict: { kind: 'same', reason: 'Both say Rina leads Ledger.' },
  })
})

it('shows only public coverage fields, with current totals once a pass is done', () => {
  const { store } = fixture()
  saveAndListMemories(store)
  while (store.sweep('all').coverage.phase !== 'done');
  const coverage = store.coverage()
  expect(Object.keys(coverage).sort()).toEqual(Object.keys(emptyBrainTidyCoverage()).sort())
  const data = extraction('later')
  saveAndListMemories(store, {
    jobId: 'later',
    memories: [{ ...data.memories[0]!, summary: 'Rina archives Harbor invoices weekly.' }],
    memoryVectors: [vector(0, 0, 1)],
  })
  const { counts } = store.snapshot()
  expect(counts.memories).toBeGreaterThan(coverage.totalMemories)
  expect(store.coverage()).toMatchObject({
    phase: 'done',
    totalMemories: counts.memories,
    totalEntities: counts.entities,
  })
})
