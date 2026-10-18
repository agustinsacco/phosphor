import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConformanceHarness } from './__fixtures__/harness'
import {
  createConformanceContext,
  createConformanceKit,
  describeConformance,
  scenario,
  scenarioEach,
  scenarioFor,
  scenarioPendingCap,
  type ScenarioTest,
} from './context'
import type { ConformanceOptions, HostConformanceHarness } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const
const DEFAULT_LIMITS = {
  authTimeoutMs: 20,
  commandDelayMs: 5,
  subscriptionsPerConnection: 3,
  pendingCommandsPerConnection: scenarioPendingCap,
  replayEvents: 30,
}

afterEach(() => {
  vi.useRealTimers()
})

/** A healthy harness whose stop and creation are logged under a name. */
function logged(log: string[], name: string, extra: Partial<HostConformanceHarness> = {}) {
  const harness = createConformanceHarness({})
  return {
    ...harness,
    ...extra,
    driver: {
      ...harness.driver,
      async stop() {
        await Promise.resolve()
        log.push(`stop ${name} ${vi.isFakeTimers() ? 'fake' : 'real'}`)
        harness.driver.stop()
      },
    },
  } satisfies HostConformanceHarness
}
function test(name: string): ScenarioTest & { skips: string[] } {
  const skips: string[] = []
  return { task: { name }, skips, skip: (note) => void skips.push(note) }
}

describe('createConformanceContext', () => {
  it('creates the default-limit harness on a fake clock fixed at 2026-01-01', async () => {
    const calls: unknown[] = []
    const harness = logged([], 'first')
    const context = createConformanceContext((limits) => {
      calls.push({ limits, fake: vi.isFakeTimers(), now: new Date(Date.now()).toISOString() })
      return harness
    }, ALL)
    await context.setUp(test('scenario'))
    expect(calls).toEqual([{ limits: DEFAULT_LIMITS, fake: true, now: '2026-01-01T00:00:00.000Z' }])
    expect(context.current()).toBe(harness)
    await context.tearDown()
  })

  it('skips only the exact title the harness names, and refuses a blank reason', async () => {
    const skipped = { 'exact title': 'Not supported here', 'blank title': ' \n' }
    const context = createConformanceContext(
      () => logged([], 'h', { skippedScenarios: skipped }),
      ALL,
    )
    const exact = test('exact title'),
      other = test('exact title (other)'),
      blank = test('blank title')
    await context.setUp(exact)
    await context.setUp(other)
    await expect(context.setUp(blank)).rejects.toThrow('A skipped scenario requires a reason')
    expect([exact.skips, other.skips, blank.skips]).toEqual([['Not supported here'], [], []])
    await context.tearDown()
  })

  it('replace stops the current harness before creating the next, and keeps it if creation fails', async () => {
    const log: string[] = []
    const first = logged(log, 'first'),
      second = logged(log, 'second')
    const created: Partial<ConformanceOptions>[] = []
    let next: HostConformanceHarness | Error = first
    const context = createConformanceContext(async (limits) => {
      created.push(limits)
      log.push('create')
      if (next instanceof Error) throw next
      return next
    }, ALL)
    await context.setUp(test('scenario'))
    next = second
    expect(await context.replace({ commandDelayMs: 7 })).toBe(second)
    expect(context.current()).toBe(second)
    next = new Error('factory failed')
    await expect(context.replace({ sendQueueBytes: 1 })).rejects.toThrow('factory failed')
    expect(context.current()).toBe(second)
    expect(created.slice(1)).toEqual([{ commandDelayMs: 7 }, { sendQueueBytes: 1 }])
    expect(log).toEqual(['create', 'stop first fake', 'create', 'stop second fake', 'create'])
    await context.tearDown()
  })

  it('tears down by awaiting stop on fake timers, and restores real timers even if stop fails', async () => {
    const log: string[] = []
    const context = createConformanceContext(() => logged(log, 'h'), ALL)
    await context.setUp(test('scenario'))
    await context.tearDown()
    expect(log).toEqual(['stop h fake'])
    expect(vi.isFakeTimers()).toBe(false)

    const failing = createConformanceContext(() => {
      const harness = logged(log, 'failing')
      const stop = async () => {
        throw new Error('stop failed')
      }
      return { ...harness, driver: { ...harness.driver, stop } }
    }, ALL)
    await failing.setUp(test('scenario'))
    await expect(failing.tearDown()).rejects.toThrow('stop failed')
    expect(vi.isFakeTimers()).toBe(false)
  })

  it('reports a scenario as lacking when any capability it needs is not announced', () => {
    const readOnly = createConformanceContext(() => logged([], 'h'), ['sessions.read'])
    expect(readOnly.lacks('sessions.read')).toBe(false)
    expect(readOnly.lacks('sessions.read', 'sessions.control')).toBe(true)
    expect(createConformanceContext(() => logged([], 'h'), []).lacks()).toBe(false)
  })
})

describe('createConformanceKit', () => {
  it('pins the starting harness and lets every helper follow a replacement', async () => {
    const connected: string[] = []
    const names = ['first', 'second']
    // Created on demand, so each grant is minted on the fake clock.
    const context = createConformanceContext(() => {
      const name = names.shift()
      if (!name) throw new Error('No harness left')
      const harness = logged([], name)
      return {
        ...harness,
        connect() {
          connected.push(name)
          return harness.connect()
        },
      }
    }, ALL)
    await context.setUp(test('scenario'))
    const kit = createConformanceKit(context)
    const first = kit.h
    const second = await kit.replace({ commandDelayMs: 5 })
    expect(kit.h).toBe(first)
    expect(context.current()).toBe(second)
    const viewer = await kit.auth()
    expect(viewer.frames[0]?.type).toBe('ready')
    expect(connected).toEqual(['second'])
    expect(kit.lacks('sessions.control')).toBe(false)
    await context.tearDown()
  })
})

const runs: unknown[][] = []
const builders = [
  scenario('plain run', async (kit, t) => {
    runs.push(['plain', kit.h.claims.iss, t.task.name])
  }),
  scenarioEach(['a', 'b'] as const, 'each %s', async (kit, value) => {
    runs.push(['each', value, kit.h.claims.iss])
  }),
  scenarioFor([1, 2], 'for %i', async (_kit, value, t) => {
    runs.push(['for', value, t.task.name])
  }),
]
describeConformance('scenario builders', createConformanceHarness, ALL, builders)

it('register plain, it.each and it.for cases in order, each with a fresh kit', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'scenario builders')
  if (suite?.type !== 'suite') throw new Error('Missing builder suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual([
    ['plain run', 'pass'],
    ['each a', 'pass'],
    ['each b', 'pass'],
    ['for 1', 'pass'],
    ['for 2', 'pass'],
  ])
  expect(builders.map((entry) => entry.title)).toEqual(['plain run', 'each %s', 'for %i'])
  expect(runs).toEqual([
    ['plain', 'https://control.test', 'plain run'],
    ['each', 'a', 'https://control.test'],
    ['each', 'b', 'https://control.test'],
    ['for', 1, 'for 1'],
    ['for', 2, 'for 2'],
  ])
})
