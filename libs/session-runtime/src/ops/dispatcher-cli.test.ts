import { expect, it, vi } from 'vitest'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { agent, createHarness, OWN } from './__fixtures__/dispatcher-harness'
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
    await dispatcher.runFromCli({ kind: 'local', clientId: 'cli' }, request),
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
  const text = async (op: string, args = {}) => {
    const result = await run(op, args)
    if (result.status === 'confirm') throw new Error(`Unexpected confirmation for ${op}`)
    return result.text
  }
  expect(await run('help')).toMatchObject({ status: 'ok', read: true })
  expect(await text('help')).not.toMatch(/\blane\b|\broutine\b/)
  expect(await text('help', { topic: 'lane.read' })).toContain('Try the other owner.')
  expect(await text('help', { topic: 'lane.list' })).toBe(await text('lane.list'))
  expect(await text('help', { topic: 'routine.list' })).toBe(await text('routine.list'))
  expect(await run('whoami')).toMatchObject({
    data: { machine: 'Test', laneRef: OWN, principal: { laneRef: OWN } },
  })
})

it('honors the owner catalog deadline and returns the canonical operation name on timeout', async () => {
  vi.useFakeTimers()
  try {
    const h = createHarness({
      handlers: {
        'lane.list': async (_args, ctx) => {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { text: 'finished' }
        },
      },
    })
    const catalog = OP_CATALOG.map((s) => (s.name === 'lane.list' ? { ...s, deadlineMs: 250 } : s))
    const dispatcher = createOpsDispatcher(h.binding, {
      ...h.deps,
      catalog,
      parseArgv: (argv) => parseOpArgv(argv),
    })
    const request = dispatcher.runFromTool('s1', {
      v: 1,
      id: 'slow',
      argv: ['lanes'],
      deadlineMs: 600_000,
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(await Promise.race([request, Promise.resolve('still running')])).toMatchObject({
      op: 'lane.list',
      status: 'error',
      code: 'timeout',
      text: expect.stringContaining('execution after 0.25 seconds'),
    })
  } finally {
    vi.useRealTimers()
  }
})

it('uses the read deadline when the catalog selects a read tier from the arguments', async () => {
  vi.useFakeTimers()
  try {
    const h = createHarness({
      flags: ['configFiles'],
      handlers: {
        'config.read': async (_args, ctx) => {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { text: 'finished' }
        },
      },
    })
    const dispatcher = createOpsDispatcher(h.binding, {
      ...h.deps,
      parseArgv: (argv) => parseOpArgv(argv),
    })
    const request = dispatcher.runFromTool('s1', {
      v: 1,
      id: 'slow-read',
      argv: ['config', 'read', 'settings'],
      deadlineMs: 600_000,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await Promise.race([request, Promise.resolve('still running')])).toMatchObject({
      op: 'config.read',
      status: 'error',
      code: 'timeout',
      text: expect.stringContaining('execution after 30 seconds'),
    })
  } finally {
    vi.useRealTimers()
  }
})
