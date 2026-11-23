/**
 * `--host`: one agent op sent to other machines through `binding.remote`.
 * This machine refuses first (routable, kill switch, never tier, `machineOps`,
 * reason, policy deny, limits), so a refused op makes no network call. Each
 * target applies its own policy and asks its own confirmations. Hosts are
 * reached four at a time; one failing host never fails the others; results
 * keep the order the caller gave. Living contract: docs/agent-control.md
 * ("Machines").
 */
import { normalizeLabel } from '@phosphor/shared/control-api'
import {
  OPS_LIMITS,
  type ConfirmItem,
  type OpsActor,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { mapLimit } from '../map-limit'
import { effectiveLimits, type OpLimits } from './limits'
import { gateVerdict, policyVerdict } from './policy'
import { policyCheck, type Judged, type Refusal } from './judge'
import type { OpsDispatcherDeps, RoutedHost } from './ports'
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

async function resolveHosts(
  deps: Pick<OpsDispatcherDeps, 'hosts'>,
  hosts: readonly string[] | 'all',
): Promise<{ ok: true; hosts: readonly RoutedHost[] } | { ok: false; text: string }> {
  if (deps.hosts) return deps.hosts.resolve(hosts)
  if (hosts === 'all')
    return { ok: false, text: 'This machine has no machine list for --host all.' }
  return { ok: true, hosts: hosts.map((id) => ({ id, label: id })) }
}

/** The request each target receives: attribution only, never authority. */
function forwarded(j: Judged, single: boolean): OpsRunRequest {
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
    ...(single && r.confirm ? { confirm: r.confirm } : {}),
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

/**
 * Several targets asked. Each keeps its own confirmation, listed per host; the
 * single origin confirmation that covers them all is X4's.
 * TODO(X4): replace with one origin confirmation over every target's items.
 */
function perHostConfirm(
  hosts: readonly RoutedHost[],
  results: readonly OpsRunResult[],
): OpsRunResult | null {
  const asked = results.flatMap((r, i) => (r.status === 'confirm' ? [{ r, host: hosts[i]! }] : []))
  const first = asked[0]?.r
  if (first?.status !== 'confirm') return null
  const items: ConfirmItem[] = asked.flatMap(({ r, host }) =>
    r.status === 'confirm'
      ? r.items.map((item) => ({
          ...item,
          hostId: host.id,
          confirmId: r.confirmId,
          digest: r.digest,
        }))
      : [],
  )
  return {
    status: 'confirm',
    confirmId: first.confirmId,
    digest: first.digest,
    title: first.title,
    message: clipBytes(
      hosts.map((host, i) => line(host, results[i]!)).join('\n'),
      OPS_LIMITS.resultBytes,
    ),
    items: items.slice(0, OPS_LIMITS.hostsPerBatch),
    expiresAt: Math.min(...asked.map(({ r }) => (r.status === 'confirm' ? r.expiresAt : Infinity))),
  }
}

/** Sends the judged op to each named machine and merges the answers in the caller's order. */
export async function routeOp(
  binding: Pick<OpsBinding, 'remote'>,
  deps: Pick<OpsDispatcherDeps, 'hosts'>,
  j: Judged,
  hosts: readonly string[] | 'all',
): Promise<OpsRunResult> {
  const remote = binding.remote
  if (!remote)
    return {
      status: 'denied',
      code: 'unsupported',
      text: 'This machine cannot reach other machines.',
    }
  const resolved = await resolveHosts(deps, hosts)
  if (!resolved.ok) return { status: 'denied', code: 'bad-request', text: resolved.text }
  const targets = resolved.hosts
  if (targets.length === 0)
    return { status: 'denied', code: 'bad-request', text: 'No machine matched --host.' }
  if (targets.length > OPS_LIMITS.hostsPerBatch)
    return {
      status: 'denied',
      code: 'bad-request',
      text: `At most ${OPS_LIMITS.hostsPerBatch} machines per operation.`,
    }
  const request = forwarded(j, targets.length === 1)
  const results = await mapLimit(targets, OPS_LIMITS.batchConcurrency, (host) =>
    reach(remote, host, request),
  )
  if (targets.length === 1) return results[0]!
  const asked = perHostConfirm(targets, results)
  if (asked) return asked
  const share = Math.floor(OPS_LIMITS.resultBytes / targets.length)
  return {
    status: 'ok',
    text: targets.map((host, i) => clipBytes(line(host, results[i]!), share - 1)).join('\n'),
    applies: j.spec.applies,
    data: {
      hosts: targets.map((host, i) => {
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
