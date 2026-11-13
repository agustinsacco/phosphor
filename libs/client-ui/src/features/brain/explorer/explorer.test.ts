import { expect, it } from 'vitest'
import { BRAIN_PREDICATE_LABELS } from '@shared/brain'
import { createMockBrain } from '../mockBrain'
import { initialTrail, moveTrail, visitTrail } from './trail'
import { buildReviewDecision } from '../reviewDecision'

it('keeps backward and forward hops and truncates the forward branch on a new visit', () => {
  const first = visitTrail(initialTrail, { kind: 'entity', id: 'harbor', label: 'Harbor' })
  const second = visitTrail(first, { kind: 'memory', id: 'ledger', label: 'Ledger decision' })
  expect(moveTrail(second, -1).index).toBe(0)
  expect(moveTrail(moveTrail(second, -1), 1)).toEqual(second)
  const branch = visitTrail(moveTrail(second, -1), { kind: 'entity', id: 'rina', label: 'Rina' })
  expect(branch.items.map((item) => item.id)).toEqual(['harbor', 'rina'])
})

it('builds review decisions with explicit identities and selected group indexes', () => {
  expect(buildReviewDecision([4, 1], { n1: 'rina', n2: 'new' }, [2])).toEqual({
    memories: [1, 4],
    identities: { n1: 'rina', n2: 'new' },
    groups: [2],
  })
})

it('uses plain directional connection labels', () => {
  expect(BRAIN_PREDICATE_LABELS.owns).toEqual({ out: 'Owns', in: 'Owned by' })
  expect(BRAIN_PREDICATE_LABELS.part_of).toEqual({ out: 'Part of', in: 'Contains' })
})

it('mock Explorer returns bounded search, pages, supported paths and a new reset generation', async () => {
  const call = createMockBrain()
  const before = await call('brain:status', [])
  const result = (await call('brain:find', ['Harbor', 5])) as { entities: { id: string }[] }
  expect(result.entities.length).toBeGreaterThan(0)
  expect(result.entities.length).toBeLessThanOrEqual(5)
  const entity = (await call('brain:entity', ['harbor'])) as { groups: { next: string | null }[] }
  expect(entity.groups.some((group) => group.next !== null)).toBe(true)
  const paths = (await call('brain:path', ['rina', 'harbor'])) as { paths: unknown[][] }
  expect(paths.paths.length).toBeGreaterThan(0)
  expect(await call('brain:reset', [])).not.toMatchObject({
    generation: (before as { generation: string }).generation,
  })
  expect(await call('brain:overview', [])).toMatchObject({ nodes: [], links: [] })
})
