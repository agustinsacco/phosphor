/**
 * The dispatcher's pipeline for one op: parse is done by the caller; here the
 * spec and args are resolved, the op is judged and refused (`judge.ts`), the
 * policy decides, an asked op becomes or redeems a confirmation, and an
 * allowed one runs its handler (or a background job). The answer carries the
 * audit id, the lane effects, deferred work and the self-reload decision.
 * Living contract: docs/agent-control.md.
 */
import {
  OPS_LIMITS,
  type OpsDenyCode,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG, type CatalogSpec } from '@phosphor/shared/ops-catalog'
import type { AuditDecision, LaneEffect, OpFacts } from '@phosphor/shared/ops'
import { undoRecordFor } from './undo'
import type { UndoRecord } from './audit'
import { orderDeferred, type LaneDeferredQueue } from './deferred'
import {
  argsError,
  judgeOp,
  policyCheck,
  refuseOp,
  resolveTarget,
  type Judged,
  type Refusal,
} from './judge'
import { LANE_CREATING_OPS, type OpLimits } from './limits'
import { policyVerdict } from './policy'
import { askingSession, confirmOrigin, isUnattended } from './principals'
import { clipBytes, routeOp, routeRefusal } from './route'
import { builtinHandlers, confirmItems, OpRefusal } from './builtins'
import type { OpRunContext, OpsDispatcherDeps } from './ports'
import type { LaneDeferred, OpHandler, OpHandlerResult, OpPrincipal, OpsBinding } from './types'

/** The pipeline's answer: the wire result plus what only a lane's own tool receives. */
export interface OpOutcome {
  readonly result: OpsRunResult
  readonly effects?: readonly LaneEffect[]
  readonly terminate?: true
  readonly untrusted?: true
}

export interface OpRunExtras {
  /** What the asking lane's tool reported; only `runFromTool` has it. */
  readonly facts?: OpFacts
  readonly hosts?: readonly string[] | 'all'
  readonly signal: AbortSignal
}

const denied = (code: OpsDenyCode, text: string): OpOutcome => ({
  result: { status: 'denied', code, text: clipBytes(text, 1000) },
})

const firstLine = (text: string): string => text.split('\n', 1)[0]?.slice(0, 160) ?? ''

const REDEMPTION: Readonly<
  Record<
    'denied' | 'expired' | 'mismatch',
    { code: OpsDenyCode; decision: AuditDecision; text: string }
  >
> = {
  denied: { code: 'confirm-denied', decision: 'denied-user', text: 'The user denied this.' },
  expired: {
    code: 'confirm-expired',
    decision: 'timeout',
    text: 'This confirmation expired. Ask again.',
  },
  mismatch: {
    code: 'confirm-mismatch',
    decision: 'denied-policy',
    text: 'This confirmation does not match the request. Ask again.',
  },
}

const REFUSED_RELOAD = {
  live: 'This lane cannot reload while sub-agent work is live; the change applies on its next reload.',
  again:
    'This lane already reloaded since the user’s last message; the change applies on its next reload.',
}

/** What every pipeline step reads: the owner's binding, the ports and the in-memory state. */
export interface PipelineEnv {
  readonly binding: OpsBinding
  readonly deps: OpsDispatcherDeps
  readonly limits: OpLimits
  readonly deferred: LaneDeferredQueue
  readonly now: () => number
  readonly specs: ReadonlyMap<string, CatalogSpec>
  readonly builtins: Readonly<Record<string, OpHandler>>
}

async function audit(
  env: PipelineEnv,
  j: Judged,
  decision: AuditDecision,
  result: string,
  undoRecord: UndoRecord | null = null,
): Promise<string | undefined> {
  if (j.governed === 'surface') return undefined
  try {
    const id = await env.binding.audit.append({
      at: env.now(),
      principal: j.key,
      ...(j.askingLane !== undefined ? { laneRef: j.askingLane } : {}),
      ...(j.askingTitle !== undefined ? { laneTitle: j.askingTitle } : {}),
      op: j.spec.name,
      tier: j.tier,
      scope: j.scope,
      ...(j.lane ? { target: j.lane.ref } : {}),
      argsSummary: env.deps.redact(j.spec, j.args),
      ...(j.request.reason !== undefined ? { reason: j.request.reason } : {}),
      decision,
      result: result.slice(0, 200),
      applies: j.spec.applies,
      undo: undoRecord !== null,
      undoRecord,
    })
    env.binding.notifySurfaces({
      kind: 'audit',
      ...(j.askingLane ? { laneRef: j.askingLane } : {}),
    })
    return id
  } catch (error) {
    env.deps.log('ops', 'audit append failed', { op: j.spec.name, error: String(error) })
    return undefined
  }
}

async function refuse(env: PipelineEnv, j: Judged, refusal: Refusal): Promise<OpOutcome> {
  if (refusal.decision) await audit(env, j, refusal.decision, refusal.text)
  return denied(refusal.code, refusal.text)
}

/** An asked op: redeem its confirmation, or leave one pending. Null means approved. */
async function ask(env: PipelineEnv, j: Judged): Promise<OpOutcome | null> {
  const sessionId = askingSession(j.principal)
  const confirm = j.request.confirm
  if (confirm) {
    const redeemed = await env.deps.confirms.consume({
      principal: j.principal,
      sessionId,
      confirm,
      op: j.spec.name,
      args: j.args,
    })
    if (redeemed === 'approved') return null
    if (redeemed === 'pending')
      return denied(
        'confirm-denied',
        'The user has not approved this yet. Ask again after they answer.',
      )
    return refuse(env, j, REDEMPTION[redeemed])
  }
  if (isUnattended(j.principal))
    return refuse(env, j, {
      code: 'unattended',
      decision: 'denied-unattended',
      text: `${j.spec.name} needs the user’s approval, and no one is watching this run.`,
    })
  const result = await env.deps.confirms.create({
    principal: j.principal,
    sessionId,
    origin: confirmOrigin(j.principal, j.request, j.askingTitle),
    spec: j.spec,
    args: j.args,
    ...(j.request.reason !== undefined ? { reason: j.request.reason } : {}),
    items: confirmItems(env.binding, j),
    ...(j.lane ? { lane: j.lane } : {}),
    ...(j.request.batch ? { batch: j.request.batch } : {}),
  })
  return { result }
}

/** The self-reload rule: one per user prompt, never under live sub-agent work. */
function reloadPlan(env: PipelineEnv, j: Judged, out: OpHandlerResult) {
  const items = out.deferred ?? []
  if (j.spec.applies !== 'reload' || !j.self || j.principal.kind !== 'agent')
    return { items, note: '' }
  const withoutReload = items.filter((item) => item.kind !== 'reload')
  if (j.lane?.facts?.subagentsLive) return { items: withoutReload, note: REFUSED_RELOAD.live }
  if (!env.deferred.claimReload(j.principal.sessionId))
    return { items: withoutReload, note: REFUSED_RELOAD.again }
  const reload: LaneDeferred = { kind: 'reload', what: firstLine(out.text) || j.spec.name }
  return {
    items: items.some((item) => item.kind === 'reload') ? items : [...items, reload],
    note: '',
    terminate: true as const,
  }
}

/** The asking lane's own work waits for its run; another lane's waits only while it runs. */
async function placeDeferred(
  env: PipelineEnv,
  j: Judged,
  items: readonly LaneDeferred[],
): Promise<void> {
  if (items.length === 0) return
  const own = j.self && j.principal.kind === 'agent' ? j.principal.sessionId : null
  const sessionId = own ?? j.lane?.sessionId ?? null
  if (sessionId === null) {
    env.deps.log('ops', 'deferred work has no lane', { op: j.spec.name })
    return
  }
  if (own !== null || j.lane?.busy) {
    env.deferred.hold(sessionId, items)
    return
  }
  const outcome = await env.binding.deferred.apply(sessionId, orderDeferred(items))
  if (!outcome.ok)
    env.deps.log('ops', 'deferred work did not apply', {
      op: j.spec.name,
      message: outcome.message,
    })
}

/** The one toast an allowed change makes in the asking lane, unless the handler made its own. */
function withToast(j: Judged, effects: readonly LaneEffect[], text: string): readonly LaneEffect[] {
  if (j.principal.kind !== 'agent' || j.tier === 'read') return effects
  if (effects.some((e) => e.kind === 'notify' || e.kind === 'swarm')) return effects
  const message = `Agent ran ${j.spec.name}: ${firstLine(text)}`.slice(0, 200)
  return [...effects, { kind: 'notify', message, level: 'info' }]
}

async function finish(
  env: PipelineEnv,
  j: Judged,
  decision: AuditDecision,
  out: OpHandlerResult,
): Promise<OpOutcome> {
  const plan = reloadPlan(env, j, out)
  const text = clipBytes(plan.note ? `${out.text}\n${plan.note}` : out.text, OPS_LIMITS.resultBytes)
  const record =
    j.governed === 'surface'
      ? null
      : undoRecordFor(j.spec, j.args, out.before, (op) => env.specs.get(op))
  const auditId = await audit(env, j, decision, text, record)
  const undo =
    auditId !== undefined && record !== null && env.binding.audit.get(auditId)?.undo === true
  await placeDeferred(env, j, plan.items).catch((error: unknown) => {
    env.deps.log('ops', 'deferred work failed', { op: j.spec.name, error: String(error) })
  })
  return {
    result: {
      status: 'ok',
      text,
      applies: j.spec.applies,
      ...(out.data !== undefined ? { data: out.data } : {}),
      ...(out.next !== undefined ? { next: out.next } : {}),
      ...(undo ? { undo: true } : {}),
      ...(auditId !== undefined ? { auditId } : {}),
    },
    effects: withToast(j, out.effects ?? [], text),
    ...(plan.terminate ? { terminate: plan.terminate } : {}),
    ...(j.spec.untrustedResult ? { untrusted: true as const } : {}),
  }
}

async function perform(
  env: PipelineEnv,
  j: Judged,
  decision: AuditDecision,
  signal: AbortSignal,
): Promise<OpOutcome> {
  const handler = env.builtins[j.spec.name] ?? env.binding.handlers[j.spec.name]
  if (!handler) return denied('unsupported', `${j.spec.name} is not available on this machine.`)
  const ctx = (s: AbortSignal): OpRunContext => ({
    principal: j.principal,
    signal: s,
    log: env.deps.log,
    ...(j.lane ? { lane: j.lane } : {}),
    ...(j.request.page !== undefined ? { page: j.request.page } : {}),
  })
  try {
    if (j.spec.job && env.deps.jobs) {
      const job = await env.deps.jobs.start({
        creator: j.key,
        op: j.spec.name,
        run: (s) => handler(j.args, ctx(s)),
      })
      const summary = j.spec.summary.replace(/\.$/, '')
      const text = `Started: ${summary}. Check it with: phosphor job status ${job.jobId}`
      return await finish(env, j, decision, { text, data: job })
    }
    const out = await handler(j.args, ctx(signal))
    if (LANE_CREATING_OPS.has(j.spec.name) && j.governed !== 'surface') env.limits.laneCreated()
    return await finish(env, j, decision, out)
  } catch (error) {
    if (error instanceof OpRefusal) return refuse(env, j, { code: error.code, text: error.message })
    const why = error instanceof Error ? error.message : String(error)
    await audit(env, j, decision, `failed: ${why}`)
    return denied('unavailable', `${j.spec.name} failed: ${why}`)
  }
}

/** `--host`: judged as a machine-scope op with no local target, refused here or sent on. */
async function executeRouted(
  env: PipelineEnv,
  input: Omit<Parameters<typeof judgeOp>[1], 'target' | 'routed'>,
  hosts: readonly string[] | 'all',
): Promise<OpOutcome> {
  const j = judgeOp(env.binding, { ...input, target: { self: false }, routed: true })
  const refusal = routeRefusal(env.binding, env.limits, j)
  if (refusal) return refuse(env, j, refusal)
  const result = await routeOp(env.binding, env.deps, j, hosts)
  await audit(env, j, 'allowed', result.status === 'ok' ? result.text : result.status)
  return { result, ...(j.spec.untrustedResult ? { untrusted: true as const } : {}) }
}

async function execute(
  env: PipelineEnv,
  principal: OpPrincipal,
  request: OpsRunRequest,
  extras: OpRunExtras,
): Promise<OpOutcome> {
  const spec = env.specs.get(request.op)
  if (!spec) return denied('unsupported', `Unknown operation ${request.op}. Run phosphor help.`)
  const invalid = argsError(spec, request.args)
  if (invalid) return denied('bad-request', `${spec.name}: ${invalid}`)
  const { policy } = await env.binding.policy.read()
  if (extras.hosts) return executeRouted(env, { principal, request, spec, policy }, extras.hosts)
  const target = resolveTarget(env.binding, principal, request.args, extras.facts)
  if ('code' in target) return denied(target.code, target.text)
  const j = judgeOp(env.binding, { principal, request, spec, target, policy })
  const refusal = refuseOp(env.binding, env.deps, env.limits, j)
  if (refusal) return refuse(env, j, refusal)
  const verdict = policyVerdict(policyCheck(j))
  if (verdict.kind === 'deny') return refuse(env, j, verdict)
  if (verdict.kind === 'ask') {
    const pending = await ask(env, j)
    if (pending) return pending
  }
  return perform(env, j, verdict.kind === 'ask' ? 'approved' : 'allowed', extras.signal)
}

export function createOpPipeline(
  binding: OpsBinding,
  deps: OpsDispatcherDeps,
  state: Pick<PipelineEnv, 'limits' | 'deferred' | 'now'>,
) {
  const env: PipelineEnv = {
    binding,
    deps,
    ...state,
    specs: new Map((deps.catalog ?? OP_CATALOG).map((spec) => [spec.name, spec])),
    builtins: builtinHandlers(binding, deps),
  }
  return {
    spec: (op: string): CatalogSpec | undefined => env.specs.get(op),
    execute: (principal: OpPrincipal, request: OpsRunRequest, extras: OpRunExtras) =>
      execute(env, principal, request, extras),
  }
}

export type OpPipeline = ReturnType<typeof createOpPipeline>
