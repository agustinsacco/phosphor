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
import { gateVerdict, policyVerdict } from './policy'
import { policyCheck, type Judged, type Refusal } from './judge'
import type { OpsDispatcherDeps, RoutedHost } from './ports'
import {
  askBatch,
  resubmitBatch,
  type BatchTarget,
  type RouteBatches,
  type Routed,
} from './route-batch'
import type { OpsBinding } from './types'

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

/** The machines `--host` names; `self` when its one value names this machine. */
export async function routeTargets(
  deps: Pick<OpsDispatcherDeps, 'hosts'>,
  hosts: readonly string[] | 'all',
): Promise<readonly RoutedHost[] | 'self' | Refusal> {
  const bad = (text: string): Refusal => ({ code: 'bad-request', text })
  if (!deps.hosts && hosts === 'all') return bad('This machine has no machine list for --host all.')
  const resolved = deps.hosts
    ? await deps.hosts.resolve(hosts)
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
  const r = j.request
  return {
    op: r.op,
    args: r.args,
    actor,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(batch ? { batch } : {}),
    ...(r.page !== undefined ? { page: r.page } : {}),
  }
}

async function reach(
  remote: Remote,
  host: RoutedHost,
  request: OpsRunRequest,
): Promise<OpsRunResult> {
  try {
    return await remote.run(host.id, request)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { status: 'denied', code: 'unavailable', text: `unavailable (${why})` }
  }
}

/** Cuts text to `bytes` UTF-8 bytes, saying so. */
export function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text
  const marker = ' […cut]'
  const kept = Buffer.from(text, 'utf8')
    .subarray(0, Math.max(0, bytes - Buffer.byteLength(marker)))
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
  return `${kept}${marker}`
}

function line(host: RoutedHost, result: OpsRunResult): string {
  if (result.status === 'ok') return `${host.label}: ${result.text}`
  if (result.status === 'denied')
    return result.text.startsWith(result.code)
      ? `${host.label}: ${result.text}`
      : `${host.label}: ${result.code}: ${result.text}`
  return `${host.label}: asks the user first: ${result.title}`
}

/** Every target's answer, in the caller's order; one target's answer unchanged. */
function merged(j: Judged, hosts: readonly RoutedHost[], results: readonly OpsRunResult[]) {
  if (hosts.length === 1) return results[0]!
  const share = Math.floor(OPS_LIMITS.resultBytes / hosts.length)
  return {
    status: 'ok' as const,
    text: hosts.map((host, i) => clipBytes(line(host, results[i]!), share - 1)).join('\n'),
    applies: j.spec.applies,
    data: {
      hosts: hosts.map((host, i) => {
        const r = results[i]!
        return {
          hostId: host.id,
          label: host.label,
          status: r.status,
          ...(r.status === 'denied' ? { code: r.code } : {}),
        }
      }),
    },
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
): Promise<Routed | Refusal> {
  const remote = binding.remote
  if (!remote) return { code: 'unsupported', text: 'This machine cannot reach other machines.' }
  const send = (host: RoutedHost, request: OpsRunRequest) => reach(remote, host, request)
  const confirm = j.request.confirm
  if (confirm) {
    const again = await resubmitBatch(batches, j, confirm, send, (batch) => forwarded(j, batch))
    if (!again) return EXPIRED
    return { result: merged(j, again.hosts, again.results), decision: 'approved' }
  }
  const batchId = targets.length > 1 ? randomUUID() : undefined
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
  return { result: merged(j, targets, results), decision: 'allowed' }
}
