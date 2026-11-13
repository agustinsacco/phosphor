import { expect, it } from 'vitest'
import { graphModel, graphNeighbors, memoryEntityIds } from './graphModel'
import { boundedGraph, graphFixture } from './__fixtures__/graph3D'

it('preserves directed parallel edges with supporting memory ids and bounded server counts', () => {
  const { entities, memories } = graphFixture()
  const graph = boundedGraph(entities, memories)
  graph.links.push({
    ...graph.links[0]!,
    id: 'reverse',
    subjectId: 'postgres',
    objectId: 'harbor',
    predicate: 'depends_on',
  })
  const before = structuredClone(graph)
  const model = graphModel(graph)
  expect(model.links.map((l) => [l.source, l.target, l.predicates])).toEqual([
    ['harbor', 'postgres', ['uses']],
    ['rina', 'harbor', ['owns']],
    ['postgres', 'harbor', ['depends_on']],
  ])
  expect(model.links[0]!.memoryId).toBe('db')
  expect(model.nodes[0]!.val).toBe(5)
  expect(graph).toEqual(before)
})
it('keeps isolated bounded nodes and drops self-links and unknown endpoints', () => {
  const { entities, memories } = graphFixture()
  const graph = boundedGraph(entities, memories)
  graph.links = [
    { ...graph.links[0]!, objectId: 'harbor' },
    { ...graph.links[0]!, objectId: 'unknown' },
  ]
  expect(graphModel(graph).links).toEqual([])
  expect(graphModel(graph).nodes).toHaveLength(3)
})
it('finds neighbours after vendor endpoint mutation and counts explicit mentions', () => {
  const { entities, memories } = graphFixture()
  const model = graphModel(boundedGraph(entities, memories))
  model.links[0]!.source = model.nodes[0]!
  model.links[0]!.target = model.nodes[1]!
  expect([...graphNeighbors(model, 'postgres')].sort()).toEqual(['harbor', 'postgres'])
  expect([...memoryEntityIds(memories)]).toEqual(['harbor', 'postgres', 'rina'])
})
