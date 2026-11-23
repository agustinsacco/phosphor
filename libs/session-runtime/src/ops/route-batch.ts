/**
 * `--host` asks: the targets that ask become ONE confirmation on this machine,
 * bound to the asking lane's dialog. Its items name each machine, its exact
 * ids and that target's own confirm, so a surface relays `confirm.approve` to
 * each target before it answers the dialog. The run submission redeems the
 * origin confirmation, then sends each asking target one submission carrying
 * its own confirm. A target that already answered, or never answered, is not
 * contacted again: a write is never resent. Living contract:
 * docs/agent-control.md ("Machines").
 */
import {
  OPS_LIMITS,
  type OpsBatchRef,
  type OpsConfirmRef,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import type { AuditDecision } from '@phosphor/shared/ops'
import { mapLimit } from '../map-limit'
import { CONFIRM_STORE_LIMITS } from './confirm'
import type { ConfirmTarget } from './confirm-message'
import { unattendedRefusal, type Judged, type Refusal } from './judge'
import { askingSession, confirmOrigin, isUnattended } from './principals'
import type { OpsDispatcherDeps, RoutedHost } from './ports'

/** A routed op's answer and the audit decision it records. */
export interface Routed {
  readonly result: OpsRunResult
  readonly decision: AuditDecision
}

/** One target of a pending batch: its first answer, and its own confirm when it asked. */
export interface BatchTarget {
  readonly host: RoutedHost
  readonly first: OpsRunResult
  readonly confirm?: OpsConfirmRef
}

interface PendingBatch {
  readonly creator: string
  readonly expiresAt: number
  readonly batchId?: string
  readonly targets: readonly BatchTarget[]
}

/** As many batches as the confirm store keeps records; the oldest goes first. */
export const ROUTE_BATCH_LIMITS = { entries: CONFIRM_STORE_LIMITS.records } as const

/** Pending batches by origin confirmId, gone once redeemed, denied or past the confirm's expiry. */
export function createRouteBatches(now: () => number, limit: number = ROUTE_BATCH_LIMITS.entries) {
  const entries = new Map<string, PendingBatch>()
  const sweep = () => {
    for (const [id, batch] of entries) if (now() >= batch.expiresAt) entries.delete(id)
  }
  return {
    remember(confirmId: string, batch: PendingBatch): void {
      sweep()
      entries.set(confirmId, batch)
      for (const id of entries.keys()) {
        if (entries.size <= limit) break
        entries.delete(id)
      }
    },
    has(confirmId: string): boolean {
      sweep()
      return entries.has(confirmId)
    },
    /** The approved batch, once: only for the principal that asked. */
    take(confirmId: string, creator: string): PendingBatch | null {
      sweep()
      const batch = entries.get(confirmId)
      if (!batch || batch.creator !== creator) return null
      entries.delete(confirmId)
      return batch
    },
    drop(confirmId: string): void {
      entries.delete(confirmId)
    },
    size(): number {
      sweep()
      return entries.size
    },
  }
}

export type RouteBatches = ReturnType<typeof createRouteBatches>

/** One machine's share of the origin confirmation: every item it reported, as one target. */
function batchItem(spec: Judged['spec'], host: RoutedHost, asked: OpsRunResult): ConfirmTarget[] {
  if (asked.status !== 'confirm') return []
  return [
    {
      hostId: host.id,
      machineLabel: host.label,
      op: spec.name,
      ids: asked.items.flatMap((item) => item.ids),
      labels: asked.items.flatMap((item) => item.labels),
      confirmId: asked.confirmId,
      digest: asked.digest,
    },
  ]
}

/**
 * The first round's asks, as one origin confirmation; null when no target asked.
 * An unattended run is refused: no one is there to approve any machine.
 */
export async function askBatch(
  deps: Pick<OpsDispatcherDeps, 'confirms'>,
  batches: RouteBatches,
  j: Judged,
  targets: readonly BatchTarget[],
  batchId: string | undefined,
): Promise<Routed | Refusal | null> {
  const items = targets.flatMap((t) => batchItem(j.spec, t.host, t.first))
  if (items.length === 0) return null
  if (isUnattended(j.principal)) return unattendedRefusal(j.spec.name)
  const result = await deps.confirms.create({
    principal: j.principal,
    sessionId: askingSession(j.principal),
    origin: confirmOrigin(j.principal, j.request, j.askingTitle),
    spec: j.spec,
    args: j.args,
    ...(j.request.reason !== undefined ? { reason: j.request.reason } : {}),
    items,
    ...(batchId !== undefined ? { batch: { id: batchId, index: 0, size: targets.length } } : {}),
  })
  if (result.status === 'confirm')
    batches.remember(result.confirmId, {
      creator: j.key,
      expiresAt: result.expiresAt,
      ...(batchId !== undefined ? { batchId } : {}),
      targets,
    })
  return { result, decision: 'allowed' }
}

/** What an asking target says when the user's approval never reached it. */
function unapproved(host: RoutedHost, result: OpsRunResult): OpsRunResult {
  return result.status === 'denied' && result.code === 'confirm-denied'
    ? {
        status: 'denied',
        code: 'confirm-denied',
        text: `Not approved on ${host.label}. Approve from an updated Phosphor app.`,
      }
    : result
}

/**
 * The run submission after the origin confirmation was redeemed: each asking
 * target gets one submission with its own confirm; the rest keep their first
 * answer. Null when the batch is gone (expired, or this machine restarted).
 */
export async function resubmitBatch(
  batches: RouteBatches,
  j: Judged,
  confirm: OpsConfirmRef,
  send: (host: RoutedHost, request: OpsRunRequest) => Promise<OpsRunResult>,
  forward: (batch?: OpsBatchRef) => OpsRunRequest,
): Promise<{ hosts: readonly RoutedHost[]; results: readonly OpsRunResult[] } | null> {
  const batch = batches.take(confirm.confirmId, j.key)
  if (!batch) return null
  const { targets, batchId } = batch
  const results = await mapLimit(targets, OPS_LIMITS.batchConcurrency, async (t, index) => {
    if (!t.confirm) return t.first
    const ref = batchId !== undefined ? { id: batchId, index, size: targets.length } : undefined
    return unapproved(t.host, await send(t.host, { ...forward(ref), confirm: t.confirm }))
  })
  return { hosts: targets.map((t) => t.host), results }
}
