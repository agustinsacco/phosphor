import { principalKey } from '../principals'
import { randomUUID } from 'node:crypto'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { READY_OP_FLAGS, type ReadyOpFlag } from '@phosphor/shared/host-protocol'
import {
  AGENT_POLICY_DEFAULT,
  type OpArgs,
  type AgentOpRow,
  type AgentPolicy,
  type ConfirmInfo,
  type OpRequestEnvelope,
} from '@phosphor/shared/ops'
import type { OpsChangedEvent } from '@phosphor/shared/ipc'
import { createOpsDispatcher } from '../dispatcher'
import type {
  ConfirmAttempt,
  OpsConfirmPort,
  OpsDispatcherDeps,
  OpsJobPort,
  OpsHostResolver,
  PendingConfirm,
} from '../ports'
import type {
  LaneDeferred,
  LaneFacts,
  OpHandler,
  OpHandlerContext,
  OpPrincipal,
  OpsBinding,
} from '../types'

export const OWN = 'local/session:s1'
export const OTHER = 'local/session:s2'
export const DIGEST = 'a'.repeat(64)

export const surface = (clientId = 'c1'): OpPrincipal => ({
  kind: 'surface',
  clientId,
  label: `Client ${clientId}`,
  via: 'owner',
})
export const agent = (
  over: Partial<Extract<OpPrincipal, { kind: 'agent' }>> = {},
): Extract<OpPrincipal, { kind: 'agent' }> => ({
  kind: 'agent',
  laneRef: OWN,
  sessionId: 's1',
  unattended: false,
  lineage: 0,
  ...over,
})
export const machine = (): OpPrincipal => ({
  kind: 'machine',
  machineId: 'm-stark',
  clientId: 'mc1',
  label: 'stark',
  lane: 'host:x/lane:y',
})
export const local = (): OpPrincipal => ({ kind: 'local', clientId: 'cli1' })

export interface HarnessOptions {
  readonly policy?: Partial<AgentPolicy>
  readonly handlers?: Readonly<Record<string, OpHandler>>
  readonly gaps?: Readonly<Record<string, string>>
  readonly flags?: readonly ReadyOpFlag[]
  readonly agents?: Readonly<Record<string, Extract<OpPrincipal, { kind: 'agent' }>>>
  readonly lanes?: readonly LaneFacts[]
  readonly createdBy?: Readonly<Record<string, number>>
  readonly jobs?: boolean
  readonly remote?: OpsBinding['remote']
  readonly hosts?: OpsHostResolver
  readonly surfaceAdmits?: OpsDispatcherDeps['surfaceAdmits']
  /** A real confirm store's port in place of the fake one. */
  readonly confirms?: OpsConfirmPort
}

const lane = (ref: string, sessionId: string, title: string): LaneFacts => ({
  ref,
  sessionId,
  title,
  cwd: '/tmp/ws',
  busy: false,
  controller: null,
})

function newCalls() {
  return {
    handled: [] as { op: string; args: unknown; ctx: OpHandlerContext }[],
    created: [] as PendingConfirm[],
    consumed: [] as ConfirmAttempt[],
    audit: [] as Omit<AgentOpRow, 'id'>[],
    applied: [] as { sessionId: string; items: readonly LaneDeferred[] }[],
    jobs: [] as Parameters<OpsJobPort['start']>[0][],
    notified: [] as Omit<OpsChangedEvent, 'machine'>[],
    voided: [] as string[],
    log: [] as { scope: string; message: string }[],
  }
}
type Calls = ReturnType<typeof newCalls>
type ConfirmEntry = { creator: string; state: 'pending' | 'approved' | 'used' }

/** Every catalog op answers `<op> done` unless the test overrides it. */
function defaultHandlers(calls: Calls, overrides: HarnessOptions['handlers']) {
  const handlers: Record<string, OpHandler> = Object.fromEntries(
    OP_CATALOG.map((spec): [string, OpHandler] => [
      spec.name,
      async (args, ctx) => {
        calls.handled.push({ op: spec.name, args, ctx })
        return { text: `${spec.name} done` }
      },
    ]),
  )
  return Object.assign(handlers, overrides)
}

function fakeBinding(
  calls: Calls,
  options: HarnessOptions,
  state: { policy: AgentPolicy; lanes: Map<string, LaneFacts> },
): OpsBinding {
  return {
    machineId: null,
    handlers: defaultHandlers(calls, options.handlers),
    gaps: options.gaps ?? {},
    flags: new Set(options.flags ?? READY_OP_FLAGS),
    policy: {
      read: async () => ({ policy: state.policy, changedOutside: false }),
      write: async (next) => {
        state.policy = next
      },
    },
    audit: {
      append: async (row) => {
        calls.audit.push(row)
        return `audit-${calls.audit.length}`
      },
      list: async () => [],
      get: () => null,
      markUndone: () => false,
      prune: () => 0,
    },
    lanes: {
      resolve: (ref) => state.lanes.get(ref) ?? null,
      createdBy: (ref) =>
        options.createdBy?.[ref] !== undefined ? { lineage: options.createdBy[ref] } : null,
    },
    deferred: {
      apply: async (sessionId, items) => {
        calls.applied.push({ sessionId, items })
        return { ok: true }
      },
    },
    ...(options.remote ? { remote: options.remote } : {}),
    notifySurfaces: (event) => calls.notified.push(event),
  }
}

/** Single use: approved once, then `mismatch`; `pending` until `approve`. */
function fakeConfirms(
  calls: Calls,
  clock: { now: number },
  confirms: Map<string, ConfirmEntry>,
): OpsConfirmPort {
  return {
    create: async (pending) => {
      calls.created.push(pending)
      const confirmId = randomUUID()
      confirms.set(confirmId, { creator: principalKey(pending.principal), state: 'pending' })
      return {
        status: 'confirm',
        confirmId,
        digest: DIGEST,
        title: `Phosphor: ${pending.spec.name}`,
        message: pending.items.map((i) => i.labels.join(', ')).join('\n'),
        items: pending.items,
        expiresAt: clock.now + 600_000,
      }
    },
    consume: async (attempt) => {
      calls.consumed.push(attempt)
      const entry = confirms.get(attempt.confirm.confirmId)
      if (!entry || entry.creator !== principalKey(attempt.principal) || entry.state === 'used')
        return 'mismatch'
      if (entry.state === 'pending') return 'pending'
      entry.state = 'used'
      return 'approved'
    },
    status: async (confirmId, creator) => {
      const entry = confirms.get(confirmId)
      return entry && entry.creator === principalKey(creator)
        ? ({ confirmId, state: entry.state === 'pending' ? 'pending' : 'approved' } as ConfirmInfo)
        : null
    },
    surfaceAnswered: () => 'relay',
    confirmSeen: () => undefined,
    voidSession: (sessionId) => calls.voided.push(sessionId),
  }
}

function fakeDeps(
  calls: Calls,
  options: HarnessOptions,
  clock: { now: number },
  confirms: OpsConfirmPort,
): OpsDispatcherDeps {
  const agents = options.agents ?? { s1: agent() }
  return {
    parseArgv: (argv) =>
      argv[0] === 'bad'
        ? { ok: false, error: 'Unknown flag --x. Did you mean --ref?' }
        : { ok: true, ...(JSON.parse(argv[0] ?? '{}') as { op: string; args: OpArgs }) },
    agentFor: (sessionId) => agents[sessionId] ?? null,
    surfaceAdmits: options.surfaceAdmits ?? (() => true),
    confirms,
    redact: (spec) => `${spec.name} args`,
    undo: {
      run: async (principal, _auditId, run) => run(principal, { op: 'swarm.off', args: {} }),
    },
    ...(options.jobs
      ? {
          jobs: {
            start: async (job) => {
              calls.jobs.push(job)
              return { jobId: `job-${calls.jobs.length}` }
            },
          },
        }
      : {}),
    ...(options.hosts ? { hosts: options.hosts } : {}),
    log: (scope, message) => calls.log.push({ scope, message }),
    now: () => clock.now,
  }
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = { now: 1_000_000 }
  const calls = newCalls()
  const state = {
    policy: { ...AGENT_POLICY_DEFAULT, ...options.policy } as AgentPolicy,
    lanes: new Map<string, LaneFacts>(
      (options.lanes ?? [lane(OWN, 's1', 'Mine'), lane(OTHER, 's2', 'Other')]).map((l) => [
        l.ref,
        l,
      ]),
    ),
  }
  const confirms = new Map<string, ConfirmEntry>()
  const binding = fakeBinding(calls, options, state)
  const deps = fakeDeps(
    calls,
    options,
    clock,
    options.confirms ?? fakeConfirms(calls, clock, confirms),
  )
  const dispatcher = createOpsDispatcher(binding, deps)
  return {
    dispatcher,
    deps,
    binding,
    calls,
    clock,
    setPolicy: (next: Partial<AgentPolicy>) => {
      state.policy = { ...AGENT_POLICY_DEFAULT, ...next }
    },
    approve: (confirmId: string) => {
      const entry = confirms.get(confirmId)
      if (entry) entry.state = 'approved'
    },
    run: (principal: OpPrincipal, request: OpsRunRequest): Promise<OpsRunResult> =>
      dispatcher.run(principal, request),
    tool: (
      request: { op: string; args?: object; hosts?: readonly string[] | 'all' },
      envelope: Partial<OpRequestEnvelope> = {},
      sessionId = 's1',
    ) =>
      dispatcher.runFromTool(sessionId, {
        v: 1,
        id: 'r1',
        argv: [JSON.stringify({ args: {}, ...request })],
        reason: 'testing',
        deadlineMs: 30_000,
        ...envelope,
      }),
  }
}

export type Harness = ReturnType<typeof createHarness>
