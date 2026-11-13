import { expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from './test-support'
import type { ProposalEntity } from './types'

function node(ref: string): ProposalEntity {
  return {
    ref,
    label: ref,
    kind: 'project',
    aliases: [],
    description: '',
    keys: [],
    decision: 'new',
    entityId: null,
    candidates: [],
    reason: '',
    auto: false,
  }
}
it('groups both directions, pages connections and memories without duplicates and finds supported paths', () => {
  const { store } = fixture()
  const data = extraction('graph')
  const refs = Array.from({ length: 50 }, (_, i) => `Harbor-${i}`)
  const memories = refs
    .slice(1)
    .map((ref, index) => ({
      ...data.memories[0]!,
      entities: [refs[0]!, ref],
      summary: `Harbor connection ${index}.`,
      links: [
        {
          subject: refs[0]!,
          predicate: 'part_of' as const,
          object: ref,
          citation: data.memories[0]!.citations[0]!,
        },
      ],
    }))
  approve(store, {
    entities: refs.map(node),
    entityVectors: refs.map(() => vector()),
    memories,
    memoryVectors: memories.map(() => vector()),
  })
  const nodes = store.overview(300).nodes
  const center = nodes.find((item) => item.label === refs[0])!
  const target = nodes.find((item) => item.label === refs[1])!
  expect(store.entity(center.id).groups[0]).toMatchObject({
    predicate: 'part_of',
    direction: 'out',
    total: 49,
  })
  expect(store.entity(center.id).groups[0]?.items).toHaveLength(8)
  expect(store.entity(target.id).groups[0]).toMatchObject({
    predicate: 'part_of',
    direction: 'in',
    total: 1,
  })
  const first = store.connections(center.id, 'part_of', 'out', null)
  const second = store.connections(center.id, 'part_of', 'out', first.next)
  expect(first.items).toHaveLength(40)
  expect(second.items).toHaveLength(9)
  expect(new Set([...first.items, ...second.items].map((item) => item.link.id)).size).toBe(49)
  const page = store.entityMemories(center.id, {}, null)
  expect(page.memories).toHaveLength(40)
  expect(store.entityMemories(center.id, {}, page.next).memories).toHaveLength(9)
  const path = store.path(target.id, nodes.find((item) => item.label === refs[2])!.id)
  expect(path.paths[0]).toHaveLength(2)
  expect(path.memories).toHaveLength(2)
  expect(
    path.paths.flat().every((link) => path.memories.some((memory) => memory.id === link.memoryId)),
  ).toBe(true)
  expect(store.neighbourhood(center.id, 2, 12).nodes).toHaveLength(12)
  expect(store.neighbourhood(center.id, 2, 12).truncated).toBe(true)
})
it('merge repoints mentions, keys, names and duplicate support, removes self-links and audits labels', () => {
  const { store, db } = fixture()
  approve(store)
  const nodes = store.overview(300).nodes
  const source = nodes.find((item) => item.label === 'Rina Okafor')!
  const target = nodes.find((item) => item.label === 'Tom Lee')!
  const harbor = nodes.find((item) => item.label === 'Harbor')!
  const old = store.entityMemories(source.id, {}, null).memories[0]!
  const data = extraction('extra')
  approve(store, {
    jobId: 'extra',
    entities: [],
    entityVectors: [],
    memories: [
      {
        ...data.memories[0]!,
        action: 'enrich',
        target: old.id,
        entities: [target.id],
        links: [
          {
            subject: target.id,
            object: harbor.id,
            predicate: 'owns',
            citation: data.memories[0]!.citations[0]!,
          },
          {
            subject: source.id,
            object: target.id,
            predicate: 'works_on',
            citation: data.memories[0]!.citations[0]!,
          },
        ],
      },
    ],
    memoryVectors: [vector()],
  })
  store.merge(source.id, target.id)
  expect(store.memory(old.id).memory.entityIds).not.toContain(source.id)
  expect(store.memory(old.id).memory.links).toHaveLength(1)
  expect(store.memory(old.id).linkQuotes[store.memory(old.id).memory.links[0]!.id]).toHaveLength(1)
  expect(store.entity(target.id).merged).toContain('Rina Okafor')
  expect(store.entity(target.id).entity.aliases).toContain('Rina')
  expect(() => store.entity(source.id)).toThrow('not found')
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
