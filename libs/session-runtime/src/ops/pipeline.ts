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
  type OpsConfirmRef,
  type OpsDenyCode,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG, type CatalogSpec } from '@phosphor/shared/ops-catalog'
import type { AuditDecision, LaneEffect, OpFacts } from '@phosphor/shared/ops'
import { inverse, completed, afterAudit, confirmationArgs, withToast } from './completion'
import type { UndoRecord } from './audit'
import type { LaneDeferredQueue } from './deferred'
import { placeDeferred, reloadPlan } from './pipeline-deferred'
import {
  argsError,
  availability,
  judgeOp,
  laneRefArg,
  policyCheck,
  refuseOp,
  resolveTarget,
  unattendedRefusal,
  type Judged,
  type Refusal,
} from './judge'
import { LANE_CREATING_OPS, type OpLimits } from './limits'
import { policyVerdict } from './policy'
import { askingSession, confirmOrigin, isUnattended } from './principals'
import { laneHostConflict, routeOp, routeRefusal, routeSelection, routeTargets } from './route'
import { clipBytes } from './route-result'
import { createRouteBatches, type RouteBatches } from './route-batch'
import { builtinHandlers, confirmItems, OpRefusal } from './builtins'
import { REDEMPTION } from './confirm-message'
import type { OpRunContext, OpsDispatcherDeps } from './ports'
import type { OpHandler, OpHandlerResult, OpPrincipal, OpsBinding, OpDeadline } from './types'

/** The pipeline's answer: the wire result plus what only a lane's own tool receives. */
export interface OpOutcome {
  readonly result: OpsRunResult
  readonly effects?: readonly LaneEffect[]
  readonly terminate?: true
  readonly untrusted?: true
}

export interface OpRunExtras extends OpDeadline {
  /** What the asking lane's tool reported; only `runFromTool` has it. */
  readonly facts?: OpFacts
  readonly hosts?: readonly string[] | 'all'
}

const denied = (code: OpsDenyCode, text: string): OpOutcome => ({
  result: { status: 'denied', code, text: clipBytes(text, 1000) },
})

/** What every pipeline step reads: the owner's binding, the ports and the in-memory state. */
export interface PipelineEnv {
  readonly binding: OpsBinding
  readonly deps: OpsDispatcherDeps
  readonly limits: OpLimits
  readonly deferred: LaneDeferredQueue
  readonly now: () => number
  readonly specs: ReadonlyMap<string, CatalogSpec>
  readonly builtins: Readonly<Record<string, OpHandler>>
  readonly batches: RouteBatches
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

/** The run submission's confirmation: null once approved; a denied or expired one also ends its `--host` batch. */
async function redeem(
  env: PipelineEnv,
  j: Judged,
  confirm: OpsConfirmRef,
): Promise<OpOutcome | null> {
  const redeemed = await env.deps.confirms.consume({
    principal: j.principal,
    sessionId: askingSession(j.principal),
    confirm,
    op: j.spec.name,
    args: confirmationArgs(j),
  })
  if (redeemed === 'approved') return null
  if (redeemed === 'pending')
    return denied(
      'confirm-denied',
      'The user has not approved this yet. Ask again after they answer.',
    )
  if (redeemed !== 'mismatch') env.batches.drop(confirm.confirmId)
  return refuse(env, j, REDEMPTION[redeemed])
}

/** An asked op: redeem its confirmation, or leave one pending. Null means approved. */
async function ask(env: PipelineEnv, j: Judged): Promise<OpOutcome | null> {
  const sessionId = askingSession(j.principal)
  if (j.request.confirm) return redeem(env, j, j.request.confirm)
  if (isUnattended(j.principal)) return refuse(env, j, unattendedRefusal(j.spec.name))
  const result = await env.deps.confirms.create({
    principal: j.principal,
    sessionId,
    origin: confirmOrigin(j.principal, j.request, j.askingTitle),
    spec: j.spec,
    args: confirmationArgs(j),
    ...(j.request.reason !== undefined ? { reason: j.request.reason } : {}),
    items: confirmItems(env.binding, j),
    ...(j.lane ? { lane: j.lane } : {}),
    ...(j.request.batch ? { batch: j.request.batch } : {}),
  })
  return { result }
}

async function finish(
  env: PipelineEnv,
  j: Judged,
  decision: AuditDecision,
  out: OpHandlerResult,
  started?: { auditId?: string },
): Promise<OpOutcome> {
  const plan = reloadPlan(env, j, out)
  const text = clipBytes(plan.note ? `${out.text}\n${plan.note}` : out.text, OPS_LIMITS.resultBytes)
  const record = j.governed === 'surface' ? null : inverse(env, j, out)
  const auditId = started ? started.auditId : await audit(env, j, decision, text, record)
  const undo =
    auditId !== undefined && record !== null && env.binding.audit.get(auditId)?.undo === true
  const items = afterAudit(env, j, auditId, plan.items)
  await placeDeferred(env, j, items).catch((error: unknown) => {
    env.deps.log('ops', 'deferred work failed', { op: j.spec.name, error: String(error) })
  })
  return {
    result: {
      status: 'ok',
      text,
      applies: j.spec.applies,
      ...(j.tier === 'read' ? { read: true as const } : {}),
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

function askingLanePending(env: PipelineEnv, j: Judged) {
  if (j.scope === 'self' && j.self && j.principal.kind === 'agent')
    return env.deferred.pending(j.principal.sessionId)
  return undefined
}

async function perform(
  env: PipelineEnv,
  j: Judged,
  decision: AuditDecision,
  signal: AbortSignal,
): Promise<OpOutcome> {
  const handler = env.builtins[j.spec.name] ?? env.binding.handlers[j.spec.name]
  if (!handler) return denied('unsupported', availability(env.binding, j.spec)!.text)
  const ctx = (s: AbortSignal): OpRunContext => ({
    principal: j.principal,
    reason: j.request.reason,
    signal: s,
    log: env.deps.log,
    pending: askingLanePending(env, j),
    ...(j.lane ? { lane: j.lane } : {}),
    ...(j.request.page !== undefined ? { page: j.request.page } : {}),
    ...(j.request.limit !== undefined ? { limit: j.request.limit } : {}),
    ...(j.spec.name === 'help'
      ? {
          help: {
            catalog: [...env.specs.values()],
            unavailableReason: (spec: CatalogSpec) => availability(env.binding, spec)?.text,
          },
        }
      : {}),
  })
  try {
    if ((j.spec.job || env.deps.background?.(j.request, j.self)) && env.deps.jobs) {
      const auditId = await audit(env, j, decision, 'Started.')
      if (LANE_CREATING_OPS.has(j.spec.name) && j.governed !== 'surface') env.limits.laneCreated()
      const job = await env.deps.jobs.start({
        creator: j.key,
        op: j.spec.name,
        run: (s) => handler(j.args, ctx(s)),
        completed: (out) => completed(env, j, auditId, out),
      })
      // The first sentence names the op; later ones are usage notes for help.
      const summary = j.spec.summary.split('. ')[0]!.replace(/\.$/, '')
      // A routed job lives on this machine, so the caller must repeat its --host.
      const where = j.principal.kind === 'machine' ? ' (with the same --host)' : ''
      const text = `Started: ${summary}. Check it with: phosphor job status ${job.jobId}${where}`
      return await finish(env, j, decision, { text, data: job, undo: false }, { auditId })
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

/** `--host`: judged as a machine-scope op with no local target, refused here or sent on. Null: it names this machine. */
async function executeRouted(
  env: PipelineEnv,
  input: Omit<Parameters<typeof judgeOp>[1], 'target' | 'routed'>,
  selection: {
    hosts: readonly string[] | 'all'
    laneHost?: string
    batch: boolean
    local?: boolean
  },
  budget: OpDeadline,
): Promise<OpOutcome | null> {
  const j = judgeOp(env.binding, { ...input, target: { self: false }, routed: true })
  const refusal = routeRefusal(env.binding, env.limits, j)
  if (refusal) return refuse(env, j, refusal)
  const confirm = j.request.confirm
  // A pending batch already holds the approved machines. A qualified ref still
  // has to agree with an explicitly named host before we redeem the approval.
  const remembered = confirm !== undefined && env.batches.has(confirm.confirmId)
  const checkHost = selection.laneHost !== undefined && selection.hosts[0] !== selection.laneHost
  const resolved =
    remembered && !checkHost ? null : await routeTargets(env.deps, selection.hosts, budget)
  if (resolved !== null) {
    const conflict = laneHostConflict(selection.laneHost, resolved, selection.local)
    if (conflict) return refuse(env, j, conflict)
    if (resolved === 'self') return null
    if ('code' in resolved) return refuse(env, j, resolved)
  }
  const blocked = confirm ? await redeem(env, j, confirm) : null
  if (blocked) return blocked
  const routed = await routeOp(
    env.binding,
    env.deps,
    env.batches,
    j,
    resolved ?? [],
    budget,
    selection.batch,
  )
  if ('code' in routed) return refuse(env, j, routed)
  const { result } = routed
  await audit(env, j, routed.decision, result.status === 'ok' ? result.text : result.status)
  return {
    result: result.status === 'ok' && j.tier === 'read' ? { ...result, read: true } : result,
    ...(j.spec.untrustedResult ? { untrusted: true as const } : {}),
  }
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
  const selection = routeSelection(
    env.binding,
    principal,
    request,
    spec,
    extras.hosts,
    env.deps.hosts?.isSelf,
  )
  if ('code' in selection) return denied(selection.code, selection.text)
  const routed = selection.hosts
    ? await executeRouted(
        env,
        { principal, request, spec, policy },
        { ...selection, hosts: selection.hosts },
        extras,
      )
    : null
  if (routed) return routed
  // An audit filter names a historical ref, not an execution target. A gap has no target
  // to discover; let the usual kill/never/gap checks decide without probing disk.
  const args = request.op === 'audit.list' || env.binding.gaps[spec.name] ? {} : request.args
  const ref = laneRefArg(spec, args)
  const discovered =
    ref !== undefined && env.binding.lanes.lookup && !env.binding.lanes.resolve(ref)
      ? await env.binding.lanes.lookup(ref)
      : null
  const target = resolveTarget(env.binding, principal, spec, args, extras.facts, discovered)
  if ('code' in target) return denied(target.code, target.text)
  let j = judgeOp(env.binding, { principal, request, spec, target, policy })
  const refusal = refuseOp(env.binding, env.deps, env.limits, j)
  if (refusal) return refuse(env, j, refusal)
  const verdict = policyVerdict(policyCheck(j))
  if (verdict.kind === 'deny') return refuse(env, j, verdict)
  if (j.spec.name === 'archive.purge' && j.args.all === true && env.deps.archiveIds) {
    try {
      const { all: _all, ...rest } = j.args
      j = { ...j, args: { ...rest, ids: await env.deps.archiveIds() } }
    } catch (error) {
      return denied(
        error instanceof OpRefusal ? error.code : 'unavailable',
        error instanceof Error ? error.message : 'Inventory unavailable.',
      )
    }
  }
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
    batches: createRouteBatches(state.now),
  }
  return {
    spec: (op: string): CatalogSpec | undefined => env.specs.get(op),
    execute: (principal: OpPrincipal, request: OpsRunRequest, extras: OpRunExtras) =>
      execute(env, principal, request, extras),
  }
}

export type OpPipeline = ReturnType<typeof createOpPipeline>
