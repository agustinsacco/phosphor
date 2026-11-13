import { expect, it } from 'vitest'
import { approve, extraction, searchFixture, vector } from './test-support'
import type { ProposalEntity, ProposalMemory } from './types'

const identity = (ref: string): ProposalEntity => ({
  ref,
  label: ref,
  kind: 'component',
  aliases: [],
  description: '',
  keys: [],
  decision: 'new',
  entityId: null,
  candidates: [],
  reason: '',
  auto: false,
})
it('recalls three structural hops with memory ids, keeps planned and other-branch facts and both disputed sides', () => {
  const { store, search } = searchFixture()
  const base = extraction('chain')
  const refs = ['Kestrel', 'Harbor project', 'Ledger customer', 'Rina team']
  const memories: ProposalMemory[] = refs
    .slice(1)
    .map((ref, i) => ({
      ...base.memories[0]!,
      summary: `${refs[i]} is part of ${ref}.`,
      entities: [refs[i]!, ref],
      links: [
        {
          subject: refs[i]!,
          predicate: 'part_of',
          object: ref,
          citation: base.memories[0]!.citations[0]!,
        },
      ],
    }))
  memories[1]!.validFrom = Date.now() + 86_400_000
  memories[2]!.branch = true
  approve(store, {
    entities: refs.map(identity),
    entityVectors: refs.map(() => vector()),
    memories,
    memoryVectors: memories.map(() => vector()),
  })
  const nodes = store.overview(300).nodes
  const kestrel = nodes.find((node) => node.label === 'Kestrel')!
  const old = store.entityMemories(kestrel.id, {}, null).memories[0]!
  approve(store, {
    jobId: 'conflict',
    entities: [],
    entityVectors: [],
    memories: [
      {
        ...base.memories[0]!,
        summary: 'Kestrel remains independent.',
        entities: [kestrel.id],
        links: [],
        action: 'conflict',
        target: old.id,
      },
    ],
    memoryVectors: [vector()],
  })
  const result = search.recall({
    query: 'Kestrel',
    vector: null,
    limit: 20,
    scope: null,
    branch: 'other',
    now: Date.now(),
  })
  expect(result.paths.some((path) => path.length === 3)).toBe(true)
  expect(
    result.paths
      .flat()
      .every((link) =>
        store.memory(link.memoryId).memory.links.some((candidate) => candidate.id === link.id),
      ),
  ).toBe(true)
  expect(result.hits.filter((hit) => hit.memory.state === 'disputed')).toHaveLength(2)
  expect(result.hits.some((hit) => hit.memory.validFrom! > Date.now())).toBe(true)
  expect(result.hits.some((hit) => hit.memory.branch === 'billing')).toBe(true)
  expect(result.branch).toBe('other')
})
it('does not expand through a non-focus hub above 200 connections and bounds neighbourhoods', () => {
  const { store, search } = searchFixture()
  const base = extraction('hub')
  const leaves = Array.from({ length: 205 }, (_, i) => `Satellite ${i}`)
  const refs = ['Kestrel', 'Ledger hub', ...leaves]
  const links = [['Kestrel', 'Ledger hub'], ...leaves.map((leaf) => ['Ledger hub', leaf])]
  const memories: ProposalMemory[] = links.map(([subject, object], i) => ({
    ...base.memories[0]!,
    summary: `Supported connection ${i}.`,
    entities: [subject!, object!],
    links: [
      {
        subject: subject!,
        object: object!,
        predicate: 'part_of',
        citation: base.memories[0]!.citations[0]!,
      },
    ],
  }))
  approve(store, {
    entities: refs.map(identity),
    entityVectors: refs.map(() => vector()),
    memories,
    memoryVectors: memories.map(() => vector()),
  })
  const kestrel = store.overview(300).nodes.find((node) => node.label === 'Kestrel')!
  const result = search.recall({
    query: 'Kestrel',
    vector: null,
    limit: 20,
    scope: null,
    branch: null,
    now: Date.now(),
  })
  expect(result.paths.every((path) => path.length <= 1)).toBe(true)
  expect(result.hits.every((hit) => hit.memory.summary === 'Supported connection 0.')).toBe(true)
  const hub = store.overview(300).nodes.find((node) => node.label === 'Ledger hub')!
  expect(store.neighbourhood(hub.id, 2, 9999).nodes.length).toBeLessThanOrEqual(300)
  const a = store.overview(300).nodes.find((node) => node.label === leaves[0])!
  const b = store.overview(300).nodes.find((node) => node.label === leaves[1])!
  expect(store.path(a.id, b.id).paths).toEqual([])
  expect(store.entity(kestrel.id).entity.connections).toBe(1)
})
