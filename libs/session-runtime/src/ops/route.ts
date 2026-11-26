/**
 * `--host`: one agent op sent to other machines through `binding.remote`.
 * This machine refuses first (routable, kill switch, never tier, `machineOps`,
 * reason, policy deny, limits), so a refused op makes no network call. Each
 * target applies its own policy; the targets that ask become one confirmation
 * here (`route-batch.ts`). `--host all` is every other machine. Hosts are
 * reached four at a time; one failing host never fails the others; results
 * keep the order the caller gave. Living contract: docs/agent-control.md
 * ("Machines").
 */
import { randomUUID } from 'node:crypto'
import { parseRemoteLaneKey } from '@phosphor/shared/remote-host'
import { normalizeLabel } from '@phosphor/shared/control-api'
import {
  OPS_LIMITS,
  type OpsActor,
  type OpsBatchRef,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { mapLimit } from '../map-limit'
import { effectiveLimits, type OpLimits } from './limits'
import { gateVerdict, LANE_TARGET_OPS, policyVerdict } from './policy'
import { laneRefArg, policyCheck, type Judged, type Refusal } from './judge'
import type { OpsDispatcherDeps, RoutedHost } from './ports'
import {
  askBatch,
  resubmitBatch,
  type BatchTarget,
  type RouteBatches,
  type Routed,
} from './route-batch'
import type { OpDeadline, OpPrincipal, OpsBinding } from './types'
import { batchResult } from './route-result'

type Remote = NonNullable<OpsBinding['remote']>

/** What this machine refuses before reaching out. Asks belong to the targets. */
export function routeRefusal(
  binding: Pick<OpsBinding, 'remote'>,
  limits: OpLimits,
  j: Judged,
): Refusal | null {
  if (j.spec.routable === false)
    return { code: 'bad-request', text: `${j.spec.name} cannot run on another machine.` }
  if (!binding.remote)
    return { code: 'unsupported', text: 'This machine cannot reach other machines.' }
  const gate = gateVerdict(policyCheck(j))
  if (gate?.kind === 'deny') return { code: gate.code, text: gate.text, decision: gate.decision }
  const reach = j.policy.machineOps
  if (reach === 'off' || (reach === 'read' && j.tier !== 'read'))
    return {
      code: 'policy',
      decision: 'denied-policy',
      text: `Reaching other machines is ${reach === 'off' ? 'off' : 'read-only'} on this machine.`,
    }
  if (j.governed !== 'surface' && j.tier !== 'read' && !j.request.reason?.trim())
    return { code: 'bad-request', text: 'Add a short reason.' }
  const verdict = policyVerdict(policyCheck(j))
  if (verdict.kind === 'deny')
    return { code: verdict.code, text: verdict.text, decision: verdict.decision }
  const limited = limits.admit({
    key: j.key,
    op: j.spec.name,
    tier: j.tier,
    lineage: null,
    limits: effectiveLimits(j.policy),
  })
  return limited ? { code: limited.code, text: limited.text, decision: limited.decision } : null
}

type HostSelection = readonly string[] | 'all'

export function routeSelection(
  binding: Pick<OpsBinding, 'machineId'>,
  principal: OpPrincipal,
  request: OpsRunRequest,
  hosts?: HostSelection,
  isSelf?: (hostId: string) => boolean,
): { hosts?: HostSelection; laneHost?: string; batch: boolean; local?: boolean } | Refusal {
  const ref =
    request.op === 'audit.list'
      ? undefined
      : LANE_TARGET_OPS.has(request.op)
        ? typeof request.args.target === 'string'
          ? request.args.target
          : undefined
        : laneRefArg(request.op, request.args)
  const laneHost = ref === undefined ? undefined : parseRemoteLaneKey(ref)?.hostId
  const batch = hosts === 'all' || (hosts?.length ?? 0) > 1
  if (batch && request.page !== undefined)
    return {
      code: 'bad-request',
      text: '--page continues on one host. Use --host <label> with that host’s cursor.',
    }
  if (batch && ref !== undefined)
    return { code: 'bad-request', text: 'A lane target applies to one host. Specify one --host.' }
  if (!laneHost) return { hosts, batch }
  const local = laneHost === (binding.machineId ?? 'local') || isSelf?.(laneHost) === true
  if (principal.kind === 'machine')
    return local
      ? { batch: false }
      : { code: 'bad-request', text: 'This lane belongs to another host.' }
  return { hosts: hosts ?? (local ? undefined : [laneHost]), laneHost, batch, local }
}

export function laneHostConflict(
  laneHost: string | undefined,
  targets: Awaited<ReturnType<typeof routeTargets>>,
  local: boolean | undefined,
): Refusal | null {
  if (!laneHost || (targets !== 'self' && 'code' in targets)) return null
  if (targets === 'self' ? local === true : targets[0]?.id === laneHost) return null
  return { code: 'bad-request', text: '--host conflicts with the host in the lane ref.' }
}

/** The machines `--host` names; `self` when its one value names this machine. */
export async function routeTargets(
  deps: Pick<OpsDispatcherDeps, 'hosts'>,
  hosts: readonly string[] | 'all',
  budget: OpDeadline,
): Promise<readonly RoutedHost[] | 'self' | Refusal> {
  const bad = (text: string): Refusal => ({ code: 'bad-request', text })
  if (!deps.hosts && hosts === 'all') return bad('This machine has no machine list for --host all.')
  const resolved = deps.hosts
    ? await deps.hosts.resolve(hosts, budget)
    : { ok: true as const, hosts: (hosts as readonly string[]).map((id) => ({ id, label: id })) }
  if (!resolved.ok) return bad(resolved.text)
  if ('self' in resolved) return 'self'
  if (resolved.hosts.length === 0) return bad('No machine matched --host.')
  if (resolved.hosts.length > OPS_LIMITS.hostsPerBatch)
    return bad(`At most ${OPS_LIMITS.hostsPerBatch} machines per operation.`)
  return resolved.hosts
}

/** The request each target receives: attribution only, never authority, and never the caller's confirm. */
function forwarded(j: Judged, batch?: OpsBatchRef): OpsRunRequest {
  const title = j.askingTitle
  const actor: OpsActor = {
    kind: 'agent',
    ...(j.askingLane !== undefined ? { lane: j.askingLane } : {}),
    ...(title !== undefined && normalizeLabel(title) === title ? { title } : {}),
  }
  const { actor: _actor, confirm: _confirm, batch: _batch, ...request } = j.request
  return { ...request, actor, ...(batch ? { batch } : {}) }
}

async function reach(
  remote: Remote,
  host: RoutedHost,
  request: OpsRunRequest,
  budget: OpDeadline,
): Promise<OpsRunResult> {
  if (budget.signal.aborted || budget.now() >= budget.deadlineAt)
    return { status: 'denied', code: 'unavailable', text: `Stopped before reaching ${host.label}.` }
  try {
    return await remote.run(host.id, request, { ...budget, target: host.machine })
  } catch {
    return { status: 'denied', code: 'unavailable', text: `Could not reach ${host.label}.` }
  }
}

const EXPIRED: Refusal = {
  code: 'confirm-expired',
  decision: 'timeout',
  text: 'This confirmation expired. Ask again.',
}

/**
 * Sends the judged op to each named machine and merges the answers in the
 * caller's order. Targets that ask become one origin confirmation; a run
 * submission whose origin confirmation was redeemed goes to the asking
 * targets only (`route-batch.ts`).
 */
export async function routeOp(
  binding: Pick<OpsBinding, 'remote'>,
  deps: Pick<OpsDispatcherDeps, 'confirms'>,
  batches: RouteBatches,
  j: Judged,
  targets: readonly RoutedHost[],
  budget: OpDeadline,
  batch: boolean,
): Promise<Routed | Refusal> {
  const remote = binding.remote
  if (!remote) return { code: 'unsupported', text: 'This machine cannot reach other machines.' }
  const send = (host: RoutedHost, request: OpsRunRequest) => reach(remote, host, request, budget)
  const confirm = j.request.confirm
  if (confirm) {
    const again = await resubmitBatch(batches, j, confirm, send, (ref) => forwarded(j, ref))
    if (!again) return EXPIRED
    return { result: batchResult(j, again.hosts, again.results, again.batch), decision: 'approved' }
  }
  const batchId = batch ? randomUUID() : undefined
  const results = await mapLimit(targets, OPS_LIMITS.batchConcurrency, (host, index) =>
    send(host, forwarded(j, batchId ? { id: batchId, index, size: targets.length } : undefined)),
  )
  const first: BatchTarget[] = targets.map((host, i) => {
    const r = results[i]!
    return r.status === 'confirm'
      ? { host, first: r, confirm: { confirmId: r.confirmId, digest: r.digest } }
      : { host, first: r }
  })
  const asked = await askBatch(deps, batches, j, first, batchId)
  if (asked) return asked
  return { result: batchResult(j, targets, results, batch), decision: 'allowed' }
}
