import { expect, it } from 'vitest'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { agent, createHarness, OTHER, OWN, surface } from './__fixtures__/dispatcher-harness'
import { LANE_TARGET_OPS } from './policy'

const write = (target: string) => ({
  op: 'files.write',
  args: { target, path: 'a.txt', content: 'x', expected: null },
  reason: 'fix',
})

it('asks before an agent writes into another lane’s folder', async () => {
  const h = createHarness()
  const result = await h.dispatcher.run(agent(), write(OTHER))
  expect(result.status).toBe('confirm')
  expect(h.calls.handled).toEqual([])
  expect(h.calls.created[0]?.lane?.ref).toBe(OTHER)
})

it('runs an agent’s write into its own lane at the op’s tier, with its own lane', async () => {
  const h = createHarness()
  expect((await h.dispatcher.run(agent(), write(OWN))).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OWN)
  expect(h.calls.audit[0]).toMatchObject({ tier: 'lane', scope: 'self', target: OWN })
})

it('lets an agent read another lane’s files without asking, and names that lane', async () => {
  const h = createHarness()
  const read = { op: 'files.read', args: { target: OTHER, path: 'a.txt' } }
  expect((await h.dispatcher.run(agent(), read)).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OTHER)
  expect(h.calls.audit[0]).toMatchObject({ scope: 'other-lane', target: OTHER })
})

it('gives a surface the lane its target names', async () => {
  const h = createHarness()
  expect((await h.dispatcher.run(surface(), write(OTHER))).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OTHER)
  const missing = await h.dispatcher.run(surface(), write('local/session:none'))
  expect(missing).toMatchObject({ status: 'denied', code: 'bad-request' })
})

it('leaves ui.open’s target alone: a view is not a lane', async () => {
  const h = createHarness()
  const open = { op: 'ui.open', args: { target: 'settings' }, reason: 'show' }
  expect((await h.dispatcher.run(agent(), open)).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OWN)
})

it('lists exactly the catalog ops whose target is a lane', () => {
  const withTarget = OP_CATALOG.filter((spec) => {
    const properties = (spec.args as { properties?: Record<string, unknown> }).properties
    return properties !== undefined && 'target' in properties && spec.name !== 'ui.open'
  }).map((spec) => spec.name)
  expect([...LANE_TARGET_OPS].sort()).toEqual(withTarget.sort())
})
