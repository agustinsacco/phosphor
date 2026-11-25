import { expect, it } from 'vitest'
import { entities } from './browse'
import type { Context } from './database'
import { saveAndListMemories, extraction, fixture, vector } from './test-support'

/**
 * Tom Lee takes over Harbor: Rina Okafor's only memory is superseded, and her ownership travels
 * to the handover memory as history, so that memory names her too.
 */
function handover() {
  const { store, db } = fixture()
  saveAndListMemories(store)
  const nodes = store.overview(300).nodes
  const id = (label: string) => nodes.find((node) => node.label === label)!.id
  const [rina, tom, harbor] = [id('Rina Okafor'), id('Tom Lee'), id('Harbor')]
  const old = store.entityMemories(rina, {}, null).memories[0]!
  const data = extraction('handover')
  const citation = { evidence: 0, quote: 'Rina owns Harbor.' }
  saveAndListMemories(store, {
    jobId: 'handover',
    origin: { sessionId: 'ledger-lane', title: 'Ledger planning' },
    entities: [],
    entityVectors: [],
    memories: [
      {
        ...data.memories[0]!,
        summary: 'Tom Lee owns the Harbor billing service now.',
        action: 'supersede',
        target: old.id,
        entities: [tom, harbor],
        links: [{ subject: tom, predicate: 'owns', object: harbor, label: 'owns', citation }],
        citations: [citation],
      },
    ],
    memoryVectors: [vector()],
  })
  return { store, db, rina, tom, harbor }
}
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)

it('counts only current memories in the header, type counts and lanes alike', () => {
  const { store, rina, harbor } = handover()
  for (const id of [rina, harbor]) {
    const view = store.entity(id)
    expect(view.entity.memories).toBe(total(view.memoryCounts))
    expect(total(Object.fromEntries(view.sources.map((s) => [s.sessionId, s.memories])))).toBe(
      view.entity.memories,
    )
  }
  expect(store.entity(rina).entity.memories).toBe(1)
  expect(store.entity(rina).sources.map((s) => [s.title, s.memories])).toEqual([
    ['Ledger planning', 1],
  ])
  expect(store.entity(harbor).entity.memories).toBe(2)
  expect(
    store
      .entity(harbor)
      .sources.map((s) => [s.title, s.memories])
      .sort(),
  ).toEqual([
    ['Harbor billing', 1],
    ['Ledger planning', 1],
  ])
})

it('browses and draws entities with the same current count', () => {
  const { store, db, rina, harbor } = handover()
  const ctx: Context = { db, now: () => 1, id: () => 'made-up' }
  const page = entities(ctx, null, 0, 100, 'connected')
  expect(page.items.find((item) => item.entity.id === harbor)!.memories).toBe(2)
  expect(page.items.find((item) => item.entity.id === rina)!.memories).toBe(1)
  expect(store.overview(300).nodes.find((node) => node.id === harbor)!.memories).toBe(2)
})

it('corrects counts stored under the old definitions as Tidy visits each record', () => {
  const { store, db, rina, harbor } = handover()
  db.exec('UPDATE entities SET memories=memories+5,connections=connections+5')
  const stored = () => store.overview(300).nodes.find((node) => node.id === harbor)!
  expect(stored().memories).toBe(7)
  while (store.sweep('all').coverage.phase === 'entities');
  // Rina's ended ownership is history: it no longer counts as a connection of Harbor.
  expect(stored()).toMatchObject({ memories: 2, connections: 2 })
  expect(store.entity(rina).entity.memories).toBe(1)
})
