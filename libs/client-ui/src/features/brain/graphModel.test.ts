import { expect, it } from 'vitest'
import type { BrainEntity, BrainMemory } from '@shared/brain'
import { graphModel, graphNeighbors, memoryEntityIds } from './graphModel'
import { mockBrainData } from './mockBrainData'

const sample = mockBrainData()
const entities: BrainEntity[] = [
  ...sample.entities,
  { id: 'tom', label: 'Tom Lee', kind: 'person', aliases: [] },
  { id: 'unused', label: 'Harbor billing archive', kind: 'document', aliases: [] },
]
const memory = (patch: Partial<BrainMemory>): BrainMemory => ({
  ...sample.details[0]!.memory,
  ...patch,
})

it('includes only mentioned entities, including literal facts and object-only mentions', () => {
  const model = graphModel(entities, [
    memory({ subjectId: 'tom', objectId: null, predicate: 'about' }),
    memory({ subjectId: 'unknown', objectId: 'harbor' }),
  ])
  expect(model.nodes).toEqual([
    { id: 'harbor', label: 'Harbor', kind: 'project', memories: 1, degree: 0, val: 2 },
    { id: 'tom', label: 'Tom Lee', kind: 'person', memories: 1, degree: 0, val: 2 },
  ])
  expect(model.links).toEqual([])
})

it('aggregates unordered pairs, counts memories once per entity and uses distinct neighbour degree', () => {
  const memories = [
    memory({}),
    memory({ subjectId: 'postgres', objectId: 'harbor', predicate: 'depends_on' }),
    memory({ predicate: 'uses' }),
    sample.details[1]!.memory,
  ]
  const original = structuredClone({ entities, memories })
  const model = graphModel(entities, memories)
  expect(
    model.nodes.map(({ id, memories, degree, val }) => ({ id, memories, degree, val })),
  ).toEqual([
    { id: 'harbor', memories: 4, degree: 2, val: 7 },
    { id: 'postgres', memories: 3, degree: 1, val: 5 },
    { id: 'rina', memories: 1, degree: 1, val: 3 },
  ])
  expect(model.links).toEqual([
    { source: 'harbor', target: 'postgres', count: 3, predicates: ['depends_on', 'uses'] },
    { source: 'harbor', target: 'rina', count: 1, predicates: ['owns'] },
  ])
  expect({ entities, memories }).toEqual(original)
})

it('drops self-links and unknown endpoints without losing known memory mentions', () => {
  const model = graphModel(entities, [
    memory({ objectId: 'harbor' }),
    memory({ objectId: 'unknown' }),
    memory({ subjectId: 'missing', objectId: 'absent' }),
  ])
  expect(model.nodes).toEqual([
    { id: 'harbor', label: 'Harbor', kind: 'project', memories: 2, degree: 0, val: 3 },
  ])
  expect(model.links).toEqual([])
  expect(graphModel(entities, [])).toEqual({ nodes: [], links: [] })
})

it('finds neighbours after the library replaces edge endpoint ids with node objects', () => {
  const model = graphModel(
    entities,
    sample.details.map((detail) => detail.memory),
  )
  model.links[0]!.source = model.nodes[0]!
  model.links[0]!.target = model.nodes[1]!
  expect([...graphNeighbors(model, 'postgres')].sort()).toEqual(['harbor', 'postgres'])
  expect([...memoryEntityIds([memory({ objectId: 'harbor' })])]).toEqual(['harbor'])
})
