import { expect, it } from 'vitest'
import { createMockBrain } from '../mockBrain'

it('mock Explorer returns bounded search, pages, routes and a new reset generation', async () => {
  const call = createMockBrain()
  const before = await call('brain:status', [])
  const result = (await call('brain:find', ['Harbor', 5])) as { entities: { id: string }[] }
  expect(result.entities.length).toBeGreaterThan(0)
  expect(result.entities.length).toBeLessThanOrEqual(5)
  const entity = (await call('brain:entity', ['harbor'])) as { groups: { next: string | null }[] }
  expect(entity.groups.some((group) => group.next !== null)).toBe(true)
  const routes = (await call('brain:path', ['rina', 'harbor'])) as { routes: unknown[][] }
  expect(routes.routes.length).toBeGreaterThan(0)
  expect(await call('brain:reset', [])).not.toMatchObject({
    generation: (before as { generation: string }).generation,
  })
  expect(await call('brain:overview', [])).toMatchObject({ nodes: [], links: [] })
})
