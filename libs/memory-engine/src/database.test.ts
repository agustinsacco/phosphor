import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { approve, extraction, vector } from './test-support'
import type { ProposalEntity, ProposalMemory } from './types'

const component = (ref: string): ProposalEntity => ({
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

it('prepares each statement once per connection, so a graph read is not one prepare per row', () => {
  let prepares = 0
  class Counting extends DatabaseSync {
    override prepare(sql: string) {
      prepares++
      return super.prepare(sql)
    }
  }
  const store = openBrainStore({ path: ':memory:', Database: Counting })
  try {
    const base = extraction('hub')
    const leaves = Array.from({ length: 40 }, (_, i) => `Harbor part ${i}`)
    const memories: ProposalMemory[] = leaves.map((leaf, i) => ({
      ...base.memories[0]!,
      summary: `Harbor part ${i} is part of Harbor.`,
      entities: [leaf, 'Harbor'],
      links: [
        {
          subject: leaf,
          predicate: 'part_of',
          object: 'Harbor',
          citation: base.memories[0]!.citations[0]!,
        },
      ],
    }))
    approve(store, {
      entities: ['Harbor', ...leaves].map(component),
      entityVectors: [vector(), ...leaves.map(() => vector())],
      memories,
      memoryVectors: memories.map(() => vector()),
    })
    const harbor = store.overview(300).nodes.find((node) => node.label === 'Harbor')!
    prepares = 0
    const graph = store.neighbourhood(harbor.id, 2, 300)
    store.overview(300)
    expect(graph.nodes).toHaveLength(41)
    expect(graph.links).toHaveLength(40)
    expect(prepares).toBeLessThan(40)
  } finally {
    store.close()
  }
})
