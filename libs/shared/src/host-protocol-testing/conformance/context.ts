// The only module of the public testing entry that imports vitest at runtime: its bundle
// keeps vitest as a single external import (src/package-boundary.test.ts). Scenarios get
// `expect` and `flush` through the kit, and client.ts through its ports.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type ExpectStatic,
  type TestContext,
} from 'vitest'
import type { GrantPayload } from '../../host-grant'
import type { LaneOp, Receipt } from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import {
  auth,
  client,
  command,
  create,
  events,
  receipts,
  snapshots,
  type ClientPorts,
  type ConformanceViewer,
} from './client'
import type { ConformanceOptions, HostConformanceFactory, HostConformanceHarness } from './types'

export const scenarioPendingCap = 2

/** Advances the fake clock, running timers and the microtasks they queue. */
export async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
}

/** The parts of vitest's test context that the per-scenario hooks read. */
export interface ScenarioTest {
  readonly task: { readonly name: string }
  skip(note: string): void
}

/** One suite's fake clock and current harness, shared by its hooks and scenarios. */
export interface ConformanceContext {
  /** The harness the running scenario talks to. */
  readonly current: () => HostConformanceHarness
  readonly lacks: (...caps: HostCapability[]) => boolean
  /** Stops the current harness, then makes the factory's harness for `limits` current. */
  readonly replace: (limits: Partial<ConformanceOptions>) => Promise<HostConformanceHarness>
  readonly setUp: (t: ScenarioTest) => Promise<void>
  /** Awaits the current harness's stop under fake timers; real timers return even if it throws. */
  readonly tearDown: () => Promise<void>
}

export function createConformanceContext(
  factory: HostConformanceFactory,
  capabilities: readonly HostCapability[],
): ConformanceContext {
  let h: HostConformanceHarness
  return {
    current: () => h,
    lacks: (...caps) => !caps.every((cap) => capabilities.includes(cap)),
    async replace(limits) {
      await h.driver.stop()
      h = await factory(limits)
      return h
    },
    async setUp(t) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      h = await factory({
        authTimeoutMs: 20,
        commandDelayMs: 5,
        subscriptionsPerConnection: 3,
        pendingCommandsPerConnection: scenarioPendingCap,
        replayEvents: 30,
      })
      const reason = h.skippedScenarios?.[t.task.name]
      if (reason !== undefined) {
        if (!reason.trim()) throw new Error('A skipped scenario requires a reason')
        t.skip(reason)
      }
    },
    async tearDown() {
      try {
        await h?.driver.stop()
      } finally {
        vi.useRealTimers()
      }
    },
  }
}

/** What a scenario sees. Helpers always use the current harness; `h` is the one it started with. */
export interface ConformanceKit {
  readonly h: HostConformanceHarness
  readonly lacks: ConformanceContext['lacks']
  readonly replace: ConformanceContext['replace']
  readonly flush: typeof flush
  readonly expect: ExpectStatic
  readonly client: () => ConformanceViewer
  readonly auth: (claims?: Partial<GrantPayload>) => Promise<ConformanceViewer>
  readonly receipts: typeof receipts
  readonly create: (c: ConformanceViewer) => Promise<string>
  readonly command: (
    c: ConformanceViewer,
    laneId: string,
    op: LaneOp,
    fence?: number,
  ) => Promise<Receipt>
  readonly events: typeof events
  readonly snapshots: typeof snapshots
}

export function createConformanceKit(context: ConformanceContext): ConformanceKit {
  const ports: ClientPorts = { current: context.current, flush, expect }
  return {
    h: context.current(),
    lacks: context.lacks,
    replace: context.replace,
    flush,
    expect,
    client: () => client(ports),
    auth: (claims) => auth(ports, claims),
    receipts,
    create: (c) => create(ports, c),
    command: (c, laneId, op, fence) => command(ports, c, laneId, op, fence),
    events,
    snapshots,
  }
}

/** One registered scenario: its title as written, expanded by vitest per case. */
export interface ConformanceScenario {
  readonly title: string
  register(context: ConformanceContext): void
}

export function scenario(
  title: string,
  run: (kit: ConformanceKit, t: TestContext) => Promise<void>,
) {
  return {
    title,
    run,
    register: (context: ConformanceContext) =>
      it(title, (t) => run(createConformanceKit(context), t)),
  }
}
/** `it.each`: the case is the only argument, as in vitest; no test context. */
export function scenarioEach<Case extends string>(
  cases: readonly Case[],
  title: string,
  run: (kit: ConformanceKit, value: Case) => Promise<void>,
) {
  return {
    title,
    cases,
    run,
    register: (context: ConformanceContext) =>
      it.each(cases)(title, (value) => run(createConformanceKit(context), value)),
  }
}
/** `it.for`: the case, then the test context. */
export function scenarioFor<Case>(
  cases: readonly Case[],
  title: string,
  run: (kit: ConformanceKit, value: Case, t: TestContext) => Promise<void>,
) {
  return {
    title,
    cases,
    run,
    register: (context: ConformanceContext) =>
      it.for(cases)(title, (value, t) => run(createConformanceKit(context), value, t)),
  }
}

/** One describe: per-scenario hooks, then each scenario in the given order. */
export function describeConformance(
  name: string,
  factory: HostConformanceFactory,
  capabilities: readonly HostCapability[],
  scenarios: readonly ConformanceScenario[],
) {
  describe(name, () => {
    const context = createConformanceContext(factory, capabilities)
    beforeEach((t) => context.setUp(t))
    afterEach(() => context.tearDown())
    for (const entry of scenarios) entry.register(context)
  })
}
