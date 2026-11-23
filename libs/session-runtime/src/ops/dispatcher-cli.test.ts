import { expect, it } from 'vitest'
import { createHarness, OWN } from './__fixtures__/dispatcher-harness'

it.each([['swarm.on', {}], ['lane.stop', { ref: OWN }]])('refuses a CLI in its own lane: %s', async (op, args) => {
  const { dispatcher } = createHarness()
  const result = await dispatcher.run({kind:'local',clientId:'cli',lane:'s1'}, {op: String(op),args: args as Record<string,unknown>,reason:'test'})
  expect(result).toMatchObject({status:'denied',text:'Use the phosphor tool for this lane.'})
})
