import type { HostBrainRequest } from '@phosphor/shared/host-brain-request'
import { brainActsOnAgentLane, brainRequiredAccess } from '@phosphor/shared/host-brain-request'
import type { BrainAccess } from '@phosphor/shared/brain-access'
import { BRAIN_SURFACE, type HostBrainMethod } from '@phosphor/shared/host-brain'
import { createConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import type { OpsRunResult, OpsConfirmRef } from '@phosphor/shared/host-protocol-ops'
import type { ReadyConnection } from './connection'
import { opPrincipalFor } from './principal'

const LIMIT = 64

/** What one Brain method needs: its rights, and whether it acts on Brain Agent's lane. */
export interface BrainRequirement {
  readonly rights: readonly BrainAccess[]
  readonly agentLane: boolean
}
export const brainRequirement = (method: HostBrainMethod): BrainRequirement => ({
  rights: brainRequiredAccess(method),
  agentLane: brainActsOnAgentLane(method),
})
/** A live check of the connection's authority for `requirement`, captured now. */
export type BrainAdmit = (requirement: BrainRequirement) => () => boolean
/** An approving connection's authenticated client and its live authority for one requirement. */
export interface BrainApprover {
  readonly client: ReadyConnection['client']
  readonly admit: () => boolean
}
type Approve = (requirement: BrainRequirement) => BrainApprover
export const deniedBrain = (
  code: Extract<OpsRunResult, { status: 'denied' }>['code'],
  text: string,
): OpsRunResult => ({ status: 'denied', code, text })

const ok = (data: unknown): OpsRunResult => ({
  status: 'ok',
  text: 'Brain approval.',
  applies: 'now',
  data,
})
const unavailable = () =>
  deniedBrain('confirm-mismatch', 'Brain approval is not available on this connection.')
const creator = (connection: ReadyConnection) => ({
  kind: 'local' as const,
  clientId: connection.connectionId,
})

function approvingSurface(connection: ReadyConnection) {
  if (!connection.principal) return null
  const principal = opPrincipalFor(connection.principal, connection.client)
  return principal.kind === 'surface' ? principal : null
}

type RecordRef = {
  creator: string
  requirement: BrainRequirement
  expiresAt: number
  approver?: BrainApprover
}

/** Isolated from generic confirmations: those do not check Brain rights or socket identity. */
class BrainApprovals {
  private readonly store = createConfirmStore()
  private readonly records = new Map<string, RecordRef>()

  clear(connectionId?: string): void {
    for (const [id, entry] of this.records) {
      if (
        entry.expiresAt <= Date.now() ||
        connectionId === entry.creator ||
        (entry.approver && !entry.approver.admit())
      )
        this.records.delete(id)
    }
  }
  request(
    connection: ReadyConnection,
    action: HostBrainRequest,
    args: Readonly<Record<string, unknown>>,
  ) {
    this.clear()
    if (
      this.records.size >= LIMIT ||
      [...this.records.values()].filter((r) => r.creator === connection.connectionId).length >= 4
    )
      return deniedBrain('limit', 'Too many pending Brain requests.')
    // Do not put prompts, refs, evidence, or settings in the confirmation text.
    const ask = this.store.create({
      creator: creator(connection),
      origin: { kind: 'local', label: 'Phosphor command line' },
      op: BRAIN_SURFACE,
      summary: `Allow ${action.method} once from the command line`,
      args,
      targets: [{ op: BRAIN_SURFACE, hostId: null, ids: [], labels: [] }],
    })
    if ('ok' in ask) return deniedBrain(ask.code, 'Could not create Brain approval.')
    this.records.set(ask.confirmId, {
      creator: connection.connectionId,
      requirement: brainRequirement(action.method),
      expiresAt: ask.expiresAt,
    })
    return ask
  }

  status(connection: ReadyConnection, id: string) {
    this.clear()
    if (this.records.get(id)?.creator !== connection.connectionId) return unavailable()
    const result = this.store.status(creator(connection), id)
    return result.ok ? ok({ state: result.info.state }) : unavailable()
  }

  list(connection: ReadyConnection, approve: Approve) {
    this.clear()
    const surface = approvingSurface(connection)
    if (!surface) return unavailable()
    const result = this.store.list(surface)
    return result.ok
      ? ok(
          result.items.filter((item) => {
            const r = this.records.get(item.confirmId)
            return r && approve(r.requirement).admit()
          }),
        )
      : unavailable()
  }

  answer(connection: ReadyConnection, id: string, approved: boolean, approve: Approve) {
    this.clear()
    const entry = this.records.get(id)
    if (!entry || entry.approver) return unavailable()
    const approver = approve(entry.requirement)
    if (!approver.admit()) return unavailable()
    const surface = approvingSurface(connection)
    if (!surface) return unavailable()
    const result = approved ? this.store.approve(surface, id) : this.store.deny(surface, id)
    if (!result.ok) return unavailable()
    if (approved) entry.approver = approver
    return ok(null)
  }

  consume(
    connection: ReadyConnection,
    confirm: OpsConfirmRef,
    args: Readonly<Record<string, unknown>>,
  ): BrainApprover | null {
    this.clear()
    const record = this.records.get(confirm.confirmId)
    const approver = record?.approver
    if (!record || record.creator !== connection.connectionId || !approver?.admit()) return null
    if (!this.store.consume(creator(connection), confirm, BRAIN_SURFACE, args).ok) return null
    this.records.delete(confirm.confirmId)
    return {
      client: approver.client,
      admit: () => Date.now() < record.expiresAt && approver.admit(),
    }
  }
}

export const createBrainApprovals = () => new BrainApprovals()
