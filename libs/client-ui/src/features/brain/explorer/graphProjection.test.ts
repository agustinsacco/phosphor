import { expect, it } from 'vitest'
import type { BrainGraph } from '@shared/brain'
import { graphLink } from '../__fixtures__/graph3D'
import { combineGraphs } from './graphProjection'

it('bounds outside selection and route additions at 300 while retaining priority nodes', () => {
  const node = (id: string) => ({
    id,
    label: id,
    kind: 'project' as const,
    aliases: [],
    description: '',
    memories: 1,
    connections: 0,
  })
  const base: BrainGraph = {
    nodes: Array.from({ length: 300 }, (_, i) => node(`Harbor ${i}`)),
    links: [],
    ended: [],
    centerId: null,
    truncated: false,
  }
  const extra: BrainGraph = {
    nodes: [node('Ledger'), node('Kestrel')],
    centerId: 'Ledger',
    truncated: false,
    ended: [],
    links: [
      graphLink({
        id: 'link-1',
        subjectId: 'Ledger',
        objectId: 'Kestrel',
        predicate: 'uses',
        memoryId: 'memory-1',
      }),
    ],
  }
  const result = combineGraphs([base, extra], ['Ledger', 'Kestrel'])
  expect(result.nodes).toHaveLength(300)
  expect(result.nodes.slice(0, 2).map((n) => n.id)).toEqual(['Ledger', 'Kestrel'])
  expect(result.links).toEqual(extra.links)
  expect(result.truncated).toBe(true)
})
