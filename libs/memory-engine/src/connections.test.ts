import { expect, it } from 'vitest'
import { approve, extraction, fixture } from './test-support'
import type { Proposal } from './types'

/** "Rina Okafor owns Harbor", stated by two memories of one read. */
function twice(): Partial<Proposal> {
  const data = extraction('twice')
  const owns = data.memories[0]!
  return {
    memories: [
      owns,
      {
        ...owns,
        summary: 'Rina Okafor is the owner of the Harbor billing service.',
        citations: [{ evidence: 0, quote: 'Before the meeting.' }],
        links: [{ ...owns.links[0]!, citation: { evidence: 0, quote: 'Before the meeting.' } }],
      },
      data.memories[1]!,
    ],
    memoryVectors: [...data.memoryVectors, data.memoryVectors[0]!],
  }
}
function setup() {
  const { store, db } = fixture()
  approve(store, twice())
  const nodes = store.overview(300).nodes
  const id = (label: string) => nodes.find((node) => node.label === label)!.id
  return { store, db, rina: id('Rina Okafor'), harbor: id('Harbor'), tom: id('Tom Lee') }
}

it('shows one connection per neighbour with the memories that support it', () => {
  const { store, rina, harbor } = setup()
  const owns = store.entity(rina).groups.find((g) => g.predicate === 'owns')!
  expect(owns).toMatchObject({ direction: 'out', total: 1, next: null })
  expect(owns.items).toHaveLength(1)
  expect(owns.items[0]).toMatchObject({ entity: { id: harbor }, supports: 2 })
  const page = store.connections(rina, 'owns', 'out', null)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.supports).toBe(2)
  const incoming = store.entity(harbor).groups.find((g) => g.predicate === 'owns')!
  expect(incoming).toMatchObject({ direction: 'in', total: 1 })
  expect(incoming.items[0]).toMatchObject({ entity: { id: rina }, supports: 2 })
})

it('counts distinct neighbours per predicate and direction as an entity connection', () => {
  const { store, rina, harbor, tom } = setup()
  expect(store.entity(rina).entity.connections).toBe(1)
  expect(store.entity(harbor).entity.connections).toBe(2)
  expect(store.entity(tom).entity.connections).toBe(1)
  expect(store.overview(300).nodes.find((node) => node.id === rina)!.connections).toBe(1)
})

it('gives the Tidy entity card distinct neighbours', () => {
  const { store, db, rina, tom } = setup()
  db.prepare(
    "INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at) VALUES ('pair','entity:pair','same_entity','sweep','open','entity',?,?,'Made-up pair.',1,1)",
  ).run(rina, tom)
  const [pair] = store.pendingPairs(40)
  const card = pair!.subjects[0]
  expect(card.type === 'entity' && card.neighbours).toEqual([{ name: 'Harbor', link: 'Owns' }])
})
