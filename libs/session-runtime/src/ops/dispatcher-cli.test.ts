import { expect, it } from 'vitest'
import { agent, createHarness, local, OWN } from './__fixtures__/dispatcher-harness'
import { createConfirmStore } from './confirm'
import { createOpsDispatcher } from './dispatcher'
import { metaHandlers } from './meta-handlers'

it.each([
  ['swarm.on', {}],
  ['lane.stop', { ref: OWN }],
])('refuses a CLI in its own lane: %s', async (op, args) => {
  const { dispatcher } = createHarness()
  const result = await dispatcher.run(
    { kind: 'local', clientId: 'cli', lane: 's1' },
    { op: String(op), args: args as Record<string, unknown>, reason: 'test' },
  )
  expect(result).toMatchObject({ status: 'denied', text: 'Use the phosphor tool for this lane.' })
})

it('keeps parser usage for CLI and tool callers', async () => {
  const h = createHarness()
  const dispatcher = createOpsDispatcher(h.binding, {
    ...h.deps,
    parseArgv: () => ({
      ok: false,
      error: 'Missing ref.',
      usage: 'Usage: phosphor lane read <lane-ref>',
    }),
  })
  const request = { v: 1 as const, id: 'parse', argv: ['lane', 'read'], deadlineMs: 1000 }
  for (const result of [
    await dispatcher.runFromTool('s1', request),
    await dispatcher.runFromCli(local(), request),
  ]) {
    expect(result).toMatchObject({
      status: 'denied',
      text: 'Missing ref.\nUsage: phosphor lane read <lane-ref>',
    })
  }
})

it('shows only served ops in help and gives the same unavailability reason as execution', async () => {
  const h = createHarness({ flags: [], gaps: { 'lane.read': 'Try the other owner.' } })
  const handlers = metaHandlers(h.binding.audit, createConfirmStore(), () => {}, {
    gaps: h.binding.gaps,
    machine: 'Test',
  })
  const dispatcher = createOpsDispatcher({ ...h.binding, handlers }, h.deps)
  const run = (op: string, args = {}) => dispatcher.run(agent(), { op, args })
  const help = await run('help')
  expect(help).toMatchObject({ status: 'ok', read: true })
  expect(help.text).not.toMatch(/\blane\b|\broutine\b/)
  expect((await run('help', { topic: 'lane.read' })).text).toContain('Try the other owner.')
  expect((await run('help', { topic: 'lane.list' })).text).toBe((await run('lane.list')).text)
  expect((await run('help', { topic: 'routine.list' })).text).toBe((await run('routine.list')).text)
  expect(await run('whoami')).toMatchObject({
    data: { machine: 'Test', laneRef: OWN, principal: { laneRef: OWN } },
  })
})
