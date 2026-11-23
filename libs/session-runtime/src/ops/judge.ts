/**
 * The admission half of the dispatcher's pipeline: resolve the op's spec, args,
 * target lane, tier and scope, then refuse it (kill switch, never tier, gaps,
 * surface checks, reason, user-off, busy, limits) before any confirmation
 * lookup. Pure over the binding's reads; no handler runs here.
 * Living contract: docs/agent-control.md ("Policy and confirmations").
 */
import { Check, Errors } from 'typebox/value'
import type { OpsDenyCode, OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import type { CatalogSpec } from '@phosphor/shared/ops-catalog'
import type {
  AgentPolicy,
  AuditDecision,
  OpArgs,
  OpFacts,
  OpScope,
  OpTier,
} from '@phosphor/shared/ops'
import { effectiveLimits, type OpLimits } from './limits'
import { gateVerdict, type PolicyCheck, type PolicyVerdict } from './policy'
import { askingLane, governedAs, principalKey, type GovernedAs } from './principals'
import type { OpsDispatcherDeps } from './ports'
import type { LaneFacts, OpPrincipal, OpsBinding } from './types'

/** An op the pipeline has resolved and may still refuse. */
export interface Judged {
  readonly principal: OpPrincipal
  readonly request: OpsRunRequest
  readonly spec: CatalogSpec
  readonly args: OpArgs
  readonly tier: OpTier
  readonly scope: OpScope
  readonly governed: GovernedAs
  readonly key: string
  /** The op targets the asking lane itself. */
  readonly self: boolean
  readonly lane?: LaneFacts
  readonly askingLane?: string
  readonly askingTitle?: string
  readonly policy: AgentPolicy
}

/** An in-band refusal; `decision` is set when the refusal is a policy outcome worth an audit row. */
export interface Refusal {
  readonly code: OpsDenyCode
  readonly text: string
  readonly decision?: AuditDecision
}

/** Ops the dispatcher serves itself, whatever the binding's handlers hold. */
export const DISPATCHER_OPS: ReadonlySet<string> = new Set(['policy.show', 'confirm.status'])

/** A surface changing another lane's conversation never takes control from the client that has it. */
const CONVERSATION_OPS: ReadonlySet<string> = new Set([
  'lane.jump',
  'lane.rewind',
  'lane.label',
  'lane.fork',
  'lane.clone',
  'lane.reload',
  'contextFiles.set',
  'mcp.lane',
])

/** Allowed on another lane while its turn runs: harmless marks, and stop (which asks). */
const BUSY_EXEMPT: ReadonlySet<string> = new Set([
  'lane.rename',
  'lane.pin',
  'lane.marker',
  'lane.markRead',
  'lane.stop',
])

const CONTEXT_FILE_NAMES: Readonly<Record<string, string>> = {
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
}

export function argsError(spec: CatalogSpec, args: OpArgs): string | null {
  if (Check(spec.args, args)) return null
  const first = Errors(spec.args, args)[0]
  if (!first) return 'invalid arguments.'
  return `${first.instancePath || 'arguments'} ${first.message}.`
}

function resolveSpecValue<T extends string>(
  value: T | ((a: OpArgs, c: { self: boolean }) => T),
  args: OpArgs,
  self: boolean,
): T {
  return typeof value === 'function' ? value(args, { self }) : value
}

/** The lane an op names (`ref`, or `lane` for artifacts and Brain), or the agent's own lane. */
export function resolveTarget(
  binding: Pick<OpsBinding, 'lanes'>,
  principal: OpPrincipal,
  args: OpArgs,
  facts: OpFacts | undefined,
): { readonly self: boolean; readonly lane?: LaneFacts } | Refusal {
  const ref =
    typeof args.ref === 'string' ? args.ref : typeof args.lane === 'string' ? args.lane : undefined
  const withFacts = (lane: LaneFacts) => (facts ? { ...lane, facts } : lane)
  if (principal.kind === 'agent' && ref === undefined) {
    const own = binding.lanes.resolve(principal.laneRef)
    return own ? { self: true, lane: withFacts(own) } : { self: true }
  }
  if (ref === undefined) return { self: false }
  const lane = binding.lanes.resolve(ref)
  if (!lane) return { code: 'bad-request', text: `No lane ${ref} on this machine.` }
  const self =
    principal.kind === 'agent' &&
    (lane.ref === principal.laneRef ||
      (lane.sessionId !== null && lane.sessionId === principal.sessionId))
  return self ? { self, lane: withFacts(lane) } : { self, lane }
}

export function judgeOp(
  binding: Pick<OpsBinding, 'lanes'>,
  input: {
    readonly principal: OpPrincipal
    readonly request: OpsRunRequest
    readonly spec: CatalogSpec
    readonly target: { readonly self: boolean; readonly lane?: LaneFacts }
    readonly policy: AgentPolicy
    readonly routed?: boolean
  },
): Judged {
  const { principal, request, spec, target, policy } = input
  const asking = askingLane(principal, request)
  const own = principal.kind === 'agent' ? binding.lanes.resolve(principal.laneRef) : null
  return {
    principal,
    request,
    spec,
    args: request.args,
    tier: resolveSpecValue(spec.tier, request.args, target.self),
    scope: input.routed ? 'machine' : resolveSpecValue(spec.scope, request.args, target.self),
    governed: governedAs(principal, request),
    key: principalKey(principal),
    self: target.self,
    ...(target.lane ? { lane: target.lane } : {}),
    ...(asking !== undefined ? { askingLane: asking } : {}),
    ...((own?.title ?? request.actor?.title)
      ? { askingTitle: own?.title ?? request.actor?.title }
      : {}),
    policy,
  }
}

export function policyCheck(j: Judged): PolicyCheck {
  return {
    op: j.spec.name,
    tier: j.tier,
    scope: j.scope,
    ...(j.spec.class ? { class: j.spec.class } : {}),
    ...(j.spec.surfaceOnly ? { surfaceOnly: true as const } : {}),
    governed: j.governed,
    policy: j.policy,
  }
}

const fromVerdict = (v: Extract<PolicyVerdict, { kind: 'deny' }>): Refusal => ({
  code: v.code,
  text: v.text,
  decision: v.decision,
})

/** Gaps, missing ready flags and missing handlers answer `unsupported`. */
export function availability(
  binding: Pick<OpsBinding, 'gaps' | 'flags' | 'handlers'>,
  spec: CatalogSpec,
): Refusal | null {
  const gap = binding.gaps[spec.name]
  if (gap !== undefined) return { code: 'unsupported', text: gap }
  if (spec.flag && !binding.flags.has(spec.flag))
    return { code: 'unsupported', text: `${spec.name} needs a newer Phosphor on this machine.` }
  if (!DISPATCHER_OPS.has(spec.name) && !binding.handlers[spec.name])
    return { code: 'unsupported', text: `${spec.name} is not available on this machine.` }
  return null
}

function surfaceRefusal(j: Judged, deps: Pick<OpsDispatcherDeps, 'surfaceAdmits'>): Refusal | null {
  if (j.principal.kind !== 'surface') return null
  if (!deps.surfaceAdmits(j.principal, j.spec.requires ?? {}))
    return { code: 'forbidden', text: `This connection is not allowed to run ${j.spec.name}.` }
  const controller = j.lane?.controller
  if (
    CONVERSATION_OPS.has(j.spec.name) &&
    controller &&
    controller.clientId !== j.principal.clientId
  )
    return {
      code: 'not-controller',
      text: `${controller.label} controls lane ${j.lane?.title ?? ''}; Phosphor will not take it over.`,
    }
  return null
}

/** The user's own off on this lane wins over an agent's on. */
export function userOffRefusal(j: Judged): Refusal | null {
  if (!j.self || j.governed === 'surface') return null
  const facts = j.lane?.facts
  if (j.spec.name === 'swarm.on' && facts?.swarm?.userOff)
    return {
      code: 'user-off',
      decision: 'denied-user-off',
      text: 'The user turned Swarm off for this lane. Ask them to turn it on.',
    }
  if (j.spec.name !== 'contextFiles.set') return null
  const off = facts?.contextFiles?.userOff ?? []
  const kind = Object.keys(CONTEXT_FILE_NAMES).find((k) => j.args[k] === true && off.includes(k))
  return kind
    ? {
        code: 'user-off',
        decision: 'denied-user-off',
        text: `The user turned off ${CONTEXT_FILE_NAMES[kind]} for this lane. Ask them to turn it on.`,
      }
    : null
}

function busyRefusal(j: Judged): Refusal | null {
  if (j.governed === 'surface' || j.scope !== 'other-lane' || j.tier === 'read') return null
  if (!j.lane?.busy || BUSY_EXEMPT.has(j.spec.name)) return null
  return {
    code: 'busy',
    text: `Lane ${j.lane.title} is running a turn; try again when it settles.`,
  }
}

function lineageOf(binding: Pick<OpsBinding, 'lanes'>, j: Judged): number | null {
  const p = j.principal
  if (p.kind === 'agent')
    return Math.max(p.lineage, binding.lanes.createdBy(p.laneRef)?.lineage ?? 0)
  if (p.kind === 'local' && p.lane !== undefined)
    return binding.lanes.createdBy(p.lane)?.lineage ?? null
  return null
}

/**
 * Every refusal that comes before the policy decision, in order. The kill
 * switch, never tier and user-off run before limits and before any
 * confirmation is looked up, so a confirmation never unlocks them.
 */
export function refuseOp(
  binding: Pick<OpsBinding, 'lanes' | 'gaps' | 'flags' | 'handlers'>,
  deps: Pick<OpsDispatcherDeps, 'surfaceAdmits'>,
  limits: OpLimits,
  j: Judged,
): Refusal | null {
  const gate = gateVerdict(policyCheck(j))
  if (gate?.kind === 'deny') return fromVerdict(gate)
  const unavailable = availability(binding, j.spec) ?? surfaceRefusal(j, deps)
  if (unavailable) return unavailable
  const needsReason = j.governed === 'agent' || j.governed === 'machine'
  if (needsReason && j.tier !== 'read' && !j.request.reason?.trim())
    return { code: 'bad-request', text: 'Add a short reason.' }
  const early = userOffRefusal(j) ?? busyRefusal(j)
  if (early) return early
  if (j.governed === 'surface') return null
  const limited = limits.admit({
    key: j.key,
    op: j.spec.name,
    tier: j.tier,
    lineage: lineageOf(binding, j),
    limits: effectiveLimits(j.policy),
  })
  return limited ? fromVerdict(limited) : null
}
