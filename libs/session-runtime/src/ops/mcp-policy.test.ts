import { expect, it, vi } from 'vitest'
import { agent, createHarness, machine } from './__fixtures__/dispatcher-harness'

it.each(['mcp.add', 'mcp.update'])('requires user confirmation for stdio %s, including remote agents', async (op) => {
  const write = vi.fn(async () => ({ text: 'written' }))
  const h = createHarness({
    handlers: { [op]: write },
    policy: { machineOps: 'all', ops: { [op]: 'allow' } },
  })
  const args = { name: 'sample', scope: 'global', config: { command: 'fixture' } }
  for (const principal of [agent(), machine()]) {
    const result = await h.run(principal, { op, args, reason: 'test' })
    expect(result.status).toBe('confirm')
    expect(write).not.toHaveBeenCalled()
  }
  const result = await h.run(agent(), { op, args: { ...args, config: { url: 'https://example.test' } }, reason: 'test' })
  expect(result.status).toBe('ok')
  expect(write).toHaveBeenCalledTimes(1)
})
