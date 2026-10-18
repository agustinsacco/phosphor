import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it, vi, type RunnerTask, type RunnerTestCase } from 'vitest'
import type { GrantPayload } from '../host-grant'
import { parseClientFrame, parseHostFrame } from '../host-protocol'
import {
  defineHostConformance,
  type ConformanceConnection,
  type ConformanceOptions,
  type HostConformanceHarness,
} from './conformance'
import { createConformanceHarness } from './conformance/__fixtures__/harness'

// Characterizes defineHostConformance through its public entry: what vitest collects, which
// reason skips a scenario, how teardown orders against fake timers, and that a command
// receipt produced off the fake clock is awaited with real event-loop turns.

/** Captured before any scenario installs fake timers. */
const realSetTimeout = globalThis.setTimeout

const SCENARIOS = [
  'requires auth as the first frame and enforces its deadline',
  'refuses a wrong signature',
  'refuses a wrong host',
  'refuses a wrong epoch',
  'refuses a wrong owner',
  'proves the enrolled Host, renews, rejects identity changes, and expires',
  'refuses a correctly signed hello naming a different enrolled Host',
  'closes open sockets and rejects revoked session grants',
  'closes open sockets and rejects revoked client grants',
  'closes malformed JSON and oversize input, but rejects unknown operations without closing',
  'lists lanes, publishes deltas, replays attention only within the current epoch',
  'snapshots, emits ordered events, replays exactly missed events, and resets across a gap or epoch',
  'deduplicates running commands, sends pending then one terminal receipt, and rejects conflicting reuse',
  'resends on a new socket mid-command without executing twice',
  'answers once when pi completes at 29999 ms around the uncertainty deadline',
  'answers once when pi completes at 30001 ms around the uncertainty deadline',
  'returns unknown for unrecorded, pruned, another client, and interrupted requests; returns stored results',
  'reports an interrupted running command as unknown without resurrecting a failed lane',
  'refuses control without the capability and runs the M2 calls',
  'bounds in-flight calls at the configured pending cap',
  'serializes takeover for all viewers, fences the old controller, releases and acquires before pi events',
  'rejects a viewer dialog answer and resolves the controller answer in the stream',
  'hydrates only latest status, widget and title state for a new viewer, and clears keys',
  'bounds subscriptions and pending commands at the configured cap',
  'stops and resumes lanes, marks attention read, and exposes failure',
  'recovers a slow viewer with one snapshot, without slowing the other viewer',
  'keeps controller ownership across disconnect and reconnect without changing its fence',
  'delivers a terminal receipt to each waiting socket of the same client only once',
  'caps finished and started receipts separately, prunes by age and does not leak pruned results',
  'keeps started receipts past the TTL and does not extend terminal retention on reads',
  'gates read operations and removes subscriptions when renewal drops read authority',
  'bounds replay by bytes and attention by count, resetting when replay is unavailable',
  'replaces an oversize event with a reset, and ends only an oversize lanes subscription',
  'stops buffered replay after an oversized event (oversize reset: false)',
  'stops buffered replay after an oversized event (oversize reset: true)',
  'caps connections per client without affecting existing sockets',
  'fails only an oversize subscription or call, leaving another lane streaming',
]
/** Scenarios with no capability check: only a harness reason can skip them. */
const UNGATED = [
  ...SCENARIOS.slice(0, 10),
  'caps connections per client without affecting existing sockets',
]
const CAPABILITY_REASON = 'requires sessions.read and sessions.control'
const HARNESS_REASON = 'Characterization harness skips every ungated scenario'
const PRECEDENCE_SCENARIO = 'bounds in-flight calls at the configured pending cap'
const PRECEDENCE_REASON = 'A harness reason is checked before the capability'
const YIELD_SCENARIO = 'stops and resumes lanes, marks attention read, and exposes failure'
const YIELD_REASON = 'Only the real-yield scenario runs here'
const DEFAULT_LIMITS = {
  authTimeoutMs: 20,
  commandDelayMs: 5,
  subscriptionsPerConnection: 3,
  pendingCommandsPerConnection: 2,
  replayEvents: 30,
}
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
/** Fake time the suite's command helper advances before it starts yielding real time. */
const COMMAND_FLUSH_MS = 5

function grantClaims(): GrantPayload {
  const iat = Math.floor(Date.now() / 1000)
  return {
    v: 1,
    iss: 'https://control.test',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'First viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
}
function unreachable(): never {
  throw new Error('A skipped scenario reached the harness')
}

const lifecycle: string[] = []
const factoryCalls: { limits: Partial<ConformanceOptions>; fakeTimers: boolean; now: number }[] = []

defineHostConformance(
  'frozen registration',
  async (limits): Promise<HostConformanceHarness> => {
    factoryCalls.push({ limits, fakeTimers: vi.isFakeTimers(), now: Date.now() })
    lifecycle.push('create')
    return {
      claims: grantClaims(),
      skippedScenarios: {
        ...Object.fromEntries(UNGATED.map((name) => [name, HARNESS_REASON])),
        [PRECEDENCE_SCENARIO]: PRECEDENCE_REASON,
      },
      publicKey: new Uint8Array(32),
      connect: unreachable,
      mintGrant: unreachable,
      verifyProof: unreachable,
      signHelloProof: unreachable,
      requestId: unreachable,
      driver: {
        emitTurn: unreachable,
        openDialog: unreachable,
        failLane: unreachable,
        emitUi: unreachable,
        restart: unreachable,
        revokeSession: unreachable,
        revokeClient: unreachable,
        executions: unreachable,
        async stop() {
          await Promise.resolve()
          lifecycle.push(vi.isFakeTimers() ? 'stop under fake timers' : 'stop under real timers')
        },
      },
    }
  },
  { capabilities: [] },
)

const deliveries: { op: string; fakeDelayMs: number }[] = []

/** Holds a non-create command's receipts until real time passes and fake time has reached the flush. */
function deferReceipts(connection: ConformanceConnection): ConformanceConnection {
  const { socket } = connection
  const listeners: ((text: string) => void)[] = []
  const held = new Map<string, { op: string; sentAt: number; frames: string[] }>()
  const deliver = (text: string) => listeners.forEach((listener) => listener(text))
  function release(requestId: string, entry: { op: string; sentAt: number; frames: string[] }) {
    const attempt = () => {
      if (Date.now() < entry.sentAt + COMMAND_FLUSH_MS) return void realSetTimeout(attempt, 1)
      held.delete(requestId)
      deliveries.push({ op: entry.op, fakeDelayMs: Date.now() - entry.sentAt })
      entry.frames.forEach(deliver)
    }
    realSetTimeout(attempt, 15)
  }
  socket.onMessage((text) => {
    const parsed = parseHostFrame(text)
    if (!parsed.ok || parsed.value.type !== 'receipt') return deliver(text)
    const { requestId, status } = parsed.value.receipt
    const entry = held.get(requestId)
    if (!entry) return deliver(text)
    entry.frames.push(text)
    if (status !== 'pending') release(requestId, entry)
  })
  return {
    ...connection,
    socket: {
      ...socket,
      onMessage: (listener) => void listeners.push(listener),
      send(text) {
        const parsed = parseClientFrame(text)
        if (parsed.ok && parsed.frame.type === 'command' && parsed.frame.op.type !== 'lane.create')
          held.set(parsed.frame.requestId, {
            op: parsed.frame.op.type,
            sentAt: Date.now(),
            frames: [],
          })
        socket.send(text)
      },
    },
  }
}

defineHostConformance('real yielding', (limits): HostConformanceHarness => {
  const harness = createConformanceHarness(limits)
  return {
    ...harness,
    skippedScenarios: Object.fromEntries(
      SCENARIOS.filter((name) => name !== YIELD_SCENARIO).map((name) => [name, YIELD_REASON]),
    ),
    connect: () => deferReceipts(harness.connect()),
  }
})

function collected(task: Readonly<RunnerTestCase>, name: string) {
  const suite = task.file.tasks.find((entry) => entry.name === name)
  if (suite?.type !== 'suite') throw new Error('Missing suite ' + name)
  return suite.tasks
}
/** vitest keeps a skip reason on the result without declaring it on TaskResult. */
function outcome(entry: RunnerTask) {
  const result = entry.result
  return [result?.state, result && 'note' in result ? result.note : undefined]
}

it('registers every scenario in its original order under its expanded title', ({ task }) => {
  for (const suite of ['frozen registration', 'real yielding']) {
    const tasks = collected(task, suite)
    expect(tasks).toHaveLength(37)
    expect(tasks.map((entry) => [entry.type, entry.name])).toEqual(
      SCENARIOS.map((name) => ['test', name]),
    )
  }
})

it('skips by the harness reason first, then by a missing capability', ({ task }) => {
  expect(collected(task, 'frozen registration').map(outcome)).toEqual(
    SCENARIOS.map((name) => [
      'skip',
      name === PRECEDENCE_SCENARIO
        ? PRECEDENCE_REASON
        : UNGATED.includes(name)
          ? HARNESS_REASON
          : CAPABILITY_REASON,
    ]),
  )
})

it('creates each harness under fake time, then awaits its stop before restoring real timers', () => {
  expect(factoryCalls).toEqual(
    SCENARIOS.map(() => ({ limits: DEFAULT_LIMITS, fakeTimers: true, now: T0 })),
  )
  // Every scenario here threw (a harness or capability skip); teardown still ran in order.
  expect(lifecycle).toEqual(SCENARIOS.flatMap(() => ['create', 'stop under fake timers']))
  expect(vi.isFakeTimers()).toBe(false)
})

it('waits for an off-clock receipt with real event-loop turns, without moving fake time', ({
  task,
}) => {
  expect(collected(task, 'real yielding').map(outcome)).toEqual(
    SCENARIOS.map((name) =>
      name === YIELD_SCENARIO ? ['pass', undefined] : ['skip', YIELD_REASON],
    ),
  )
  expect(deliveries).toEqual(
    ['lane.stop', 'prompt', 'lane.resume', 'lane.markRead'].map((op) => ({
      op,
      fakeDelayMs: COMMAND_FLUSH_MS,
    })),
  )
})
