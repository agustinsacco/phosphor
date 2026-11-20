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

it('pages distinct neighbours with a stable cursor when their support interleaves', () => {
  const { store } = fixture()
  const data = extraction('pages')
  const refs = Array.from({ length: 46 }, (_, i) => `Kestrel-${i}`)
  const link = (ref: string, round: number) => ({
    ...data.memories[0]!,
    entities: [refs[0]!, ref],
    summary: `Kestrel part ${ref} round ${round}.`,
    links: [
      {
        subject: refs[0]!,
        predicate: 'part_of' as const,
        object: ref,
        citation: data.memories[0]!.citations[0]!,
      },
    ],
  })
  // Every neighbour is stated in both rounds, so its older link sits a whole page away.
  const memories = [1, 2].flatMap((round) => refs.slice(1).map((ref) => link(ref, round)))
  approve(store, {
    entities: refs.map((ref) => ({
      ...extraction('x').entities[0]!,
      ref,
      label: ref,
      aliases: [],
    })),
    entityVectors: refs.map(() => extraction('x').entityVectors[0]!),
    memories,
    memoryVectors: memories.map(() => extraction('x').memoryVectors[0]!),
  })
  const center = store.overview(300).nodes.find((node) => node.label === refs[0])!
  expect(store.entity(center.id).groups[0]).toMatchObject({ total: 45 })
  const first = store.connections(center.id, 'part_of', 'out', null)
  const second = store.connections(center.id, 'part_of', 'out', first.next)
  expect(first.items).toHaveLength(40)
  expect(second.items).toHaveLength(5)
  expect(second.next).toBeNull()
  const seen = [...first.items, ...second.items]
  expect(new Set(seen.map((item) => item.entity.id)).size).toBe(45)
  expect(seen.every((item) => item.supports === 2)).toBe(true)
  expect(store.entity(center.id).entity.connections).toBe(45)
})
