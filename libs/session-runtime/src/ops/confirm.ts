/**
 * Pending confirmations for asked ops. An asked op's first submission creates
 * one here and runs nothing; the run submission carries `{confirmId, digest}`
 * and runs only once the confirmation is approved, by the creator that asked
 * (an agent's own session), for the same op and canonical args, before expiry,
 * and only once.
 *
 * Approval is a surface's act. An agent's ask is a real pi `confirm` dialog:
 * `confirmSeen` binds it when exactly one unbound pending confirmation of that
 * session has the identical title and message, and `surfaceAnswered` records
 * the answer only from a surface origin. Other machines' items, and asks from
 * the CLI or another machine, are approved with `confirm.approve` by a surface.
 *
 * In memory: a restart voids every pending ask, which fails closed.
 * Living contract: docs/agent-control.md.
 */
import { randomUUID } from 'node:crypto'
import { normalizeLabel } from '@phosphor/shared/control-api'
import {
  OPS_LIMITS,
  parseOpsRunResult,
  type ConfirmItem,
  type OpsConfirmRef,
  type OpsDenyCode,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { CONFIRM_TITLE_PREFIX, type ConfirmInfo } from '@phosphor/shared/ops'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import { renderConfirm, type ConfirmTarget } from './confirm-message'
import { canonicalJson, sha256Hex } from './redact'
import type { OpPrincipal } from './types'

export type { ConfirmTarget } from './confirm-message'

export const CONFIRM_STORE_LIMITS = {
  /** Records kept at once; the oldest goes first, which fails closed. */
  records: 500,
  /** How long a settled or expired record stays readable by `confirm.status`. */
  keepAfterMs: OPS_LIMITS.confirmTtlMs,
} as const

export type ConfirmResult = Extract<OpsRunResult, { status: 'confirm' }>
export type ConfirmFailure = {
  readonly ok: false
  readonly code: OpsDenyCode
  readonly text: string
}

/** What an asked op shows. The store renders the title and message from it. */
export interface ConfirmAsk {
  readonly creator: Exclude<OpPrincipal, { kind: 'surface' }>
  readonly origin: ConfirmInfo['origin']
  readonly op: string
  /** The action in words, e.g. "Delete 3 lanes"; the title is `Phosphor: <summary>`. */
  readonly summary: string
  /** The validated args; only their hash is kept. */
  readonly args: Readonly<Record<string, unknown>>
  readonly reason?: string
  readonly targets: readonly ConfirmTarget[]
  readonly batchId?: string
}

export type ConsumeResult =
  | {
      readonly ok: true
      readonly confirmId: string
      readonly dialogId?: string
      readonly approvedBy: string
      readonly batchId?: string
    }
  | (ConfirmFailure & { readonly state?: ConfirmInfo['state'] })

type Answer = { readonly ok: true; readonly info: ConfirmInfo } | ConfirmFailure

interface Pending {
  readonly confirmId: string
  readonly digest: string
  readonly creator: string
  readonly sessionId: string | null
  readonly op: string
  readonly argsHash: string
  readonly title: string
  readonly message: string
  readonly items: readonly ConfirmItem[]
  readonly origin: ConfirmInfo['origin']
  readonly reason?: string
  readonly batchId?: string
  readonly expiresAt: number
  state: 'pending' | 'approved' | 'denied' | 'used'
  dialogId?: string
  approvedBy?: string
}

export interface ConfirmStore {
  create(ask: ConfirmAsk): ConfirmResult | ConfirmFailure
  /** The run submission: approved, same creator, op, args and digest, unexpired, unused. */
  consume(
    principal: OpPrincipal,
    ref: OpsConfirmRef,
    op: string,
    args: Readonly<Record<string, unknown>>,
  ): ConsumeResult
  confirmSeen(sessionId: string, dialog: { id: string; title: string; message: string }): void
  surfaceAnswered(
    sessionId: string,
    response: ExtensionUIResponse,
    answer?: { readonly origin?: string; readonly by?: string },
  ): 'relay' | 'forbidden'
  approve(principal: OpPrincipal, confirmId: string): Answer
  deny(principal: OpPrincipal, confirmId: string): Answer
  info(principal: OpPrincipal, key: { confirmId: string } | { dialogId: string }): Answer
  list(
    principal: OpPrincipal,
  ): { readonly ok: true; readonly items: ConfirmInfo[] } | ConfirmFailure
  /** `confirm.status`: the creator only. */
  status(principal: OpPrincipal, confirmId: string): Answer
  /** Stop or exit: the session's pending asks can no longer be approved. */
  voidSession(sessionId: string): void
}

export interface ConfirmStoreOptions {
  readonly now?: () => number
  readonly newId?: () => string
}

/** Who may resubmit and read status: one agent session, one machine, one local client. */
export function confirmCreatorKey(p: OpPrincipal): string {
  if (p.kind === 'agent') return `agent:${p.sessionId}`
  if (p.kind === 'machine') return `machine:${p.machineId}`
  return `${p.kind}:${p.clientId}`
}

export function confirmArgsHash(op: string, args: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson({ op, args }))
}

const fail = (code: OpsDenyCode, text: string): ConfirmFailure => ({ ok: false, code, text })
const SURFACE_ONLY = fail('forbidden', 'Only you can do this, in Phosphor.')
const UNKNOWN = fail('confirm-mismatch', 'There is no pending confirmation with that id.')

/** Arrow members, so a handler map may hold `store.approve` unbound. */
class MemoryConfirmStore implements ConfirmStore {
  private readonly records = new Map<string, Pending>()
  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  private sweep(): void {
    const t = this.now()
    for (const [id, r] of this.records)
      if (r.expiresAt + CONFIRM_STORE_LIMITS.keepAfterMs <= t) this.records.delete(id)
    for (const id of this.records.keys()) {
      if (this.records.size <= CONFIRM_STORE_LIMITS.records) break
      this.records.delete(id)
    }
  }

  private view(r: Pending): ConfirmInfo {
    const live = this.now() < r.expiresAt
    const state =
      r.state === 'denied' ? 'denied' : r.state === 'used' ? 'approved' : live ? r.state : 'expired'
    return {
      confirmId: r.confirmId,
      digest: r.digest,
      state,
      origin: r.origin,
      op: r.op,
      title: r.title,
      message: r.message,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      items: r.items,
      expiresAt: r.expiresAt,
      ...(r.batchId !== undefined ? { batchId: r.batchId } : {}),
      ...(r.dialogId !== undefined ? { dialogId: r.dialogId } : {}),
    }
  }

  private settle(principal: OpPrincipal, confirmId: string, approve: boolean): Answer {
    if (principal.kind !== 'surface') return SURFACE_ONLY
    const r = this.records.get(confirmId)
    if (!r) return UNKNOWN
    if (r.state === 'pending' && this.now() < r.expiresAt) {
      r.state = approve ? 'approved' : 'denied'
      if (approve) r.approvedBy = principal.label
    }
    const info = this.view(r)
    if (info.state === (approve ? 'approved' : 'denied')) return { ok: true, info }
    if (info.state === 'expired') return fail('confirm-expired', 'This confirmation expired.')
    return fail('confirm-denied', `This confirmation was already ${info.state}.`)
  }

  readonly create = (ask: ConfirmAsk): ConfirmResult | ConfirmFailure => {
    this.sweep()
    const confirmId = this.newId()
    const rendered = renderConfirm(ask, confirmId)
    if (!rendered.ok) return rendered
    const expiresAt = this.now() + OPS_LIMITS.confirmTtlMs
    const argsHash = confirmArgsHash(ask.op, ask.args)
    const { title, message, items } = rendered
    const digest = sha256Hex(
      canonicalJson({ v: 1, confirmId, op: ask.op, argsHash, title, message, items, expiresAt }),
    )
    const result = { status: 'confirm', confirmId, digest, title, message, items, expiresAt }
    const checked = parseOpsRunResult(result)
    if (checked?.status !== 'confirm')
      return fail('bad-request', 'The confirmation does not fit the protocol.')
    this.records.set(confirmId, {
      confirmId,
      digest,
      creator: confirmCreatorKey(ask.creator),
      sessionId: ask.creator.kind === 'agent' ? ask.creator.sessionId : null,
      op: ask.op,
      argsHash,
      title,
      message,
      items: checked.items,
      origin: ask.origin,
      ...(ask.reason !== undefined ? { reason: ask.reason } : {}),
      ...(ask.batchId !== undefined ? { batchId: ask.batchId } : {}),
      expiresAt,
      state: 'pending',
    })
    this.sweep()
    return checked
  }

  readonly consume: ConfirmStore['consume'] = (principal, ref, op, args) => {
    const r = this.records.get(ref.confirmId)
    if (!r) return UNKNOWN
    if (r.creator !== confirmCreatorKey(principal))
      return fail('confirm-mismatch', 'This confirmation belongs to someone else.')
    if (r.digest !== ref.digest || r.op !== op || r.argsHash !== confirmArgsHash(op, args))
      return fail('confirm-mismatch', 'This is not the action that was confirmed.')
    if (r.state === 'used') return fail('confirm-expired', 'This confirmation was already used.')
    const state = this.view(r).state
    if (state === 'expired')
      return { ...fail('confirm-expired', 'This confirmation expired.'), state }
    if (state !== 'approved')
      return { ...fail('confirm-denied', 'This action was not approved.'), state }
    r.state = 'used'
    return {
      ok: true,
      confirmId: r.confirmId,
      approvedBy: r.approvedBy ?? 'you',
      ...(r.dialogId !== undefined ? { dialogId: r.dialogId } : {}),
      ...(r.batchId !== undefined ? { batchId: r.batchId } : {}),
    }
  }

  readonly confirmSeen: ConfirmStore['confirmSeen'] = (sessionId, dialog) => {
    if (!dialog.title.startsWith(CONFIRM_TITLE_PREFIX)) return
    const all = [...this.records.values()]
    if (all.some((r) => r.sessionId === sessionId && r.dialogId === dialog.id)) return
    const t = this.now()
    const [only, ...rest] = all.filter(
      (r) =>
        r.sessionId === sessionId &&
        r.state === 'pending' &&
        r.dialogId === undefined &&
        t < r.expiresAt &&
        r.title === dialog.title &&
        r.message === dialog.message,
    )
    if (only && rest.length === 0) only.dialogId = dialog.id
  }

  readonly surfaceAnswered: ConfirmStore['surfaceAnswered'] = (
    sessionId,
    response,
    answer = {},
  ) => {
    const r = [...this.records.values()].find(
      (p) => p.sessionId === sessionId && p.dialogId === response.id,
    )
    if (!r) return 'relay'
    if (answer.origin !== undefined && answer.origin !== 'surface') return 'forbidden'
    if (r.state === 'pending' && this.now() < r.expiresAt) {
      const approved = 'confirmed' in response && response.confirmed
      r.state = approved ? 'approved' : 'denied'
      if (approved) r.approvedBy = normalizeLabel(answer.by) ?? 'you'
    }
    return 'relay'
  }

  readonly approve: ConfirmStore['approve'] = (principal, id) => this.settle(principal, id, true)
  readonly deny: ConfirmStore['deny'] = (principal, id) => this.settle(principal, id, false)

  readonly info: ConfirmStore['info'] = (principal, key) => {
    if (principal.kind !== 'surface') return SURFACE_ONLY
    const r =
      'confirmId' in key
        ? this.records.get(key.confirmId)
        : [...this.records.values()].find((p) => p.dialogId === key.dialogId)
    return r ? { ok: true, info: this.view(r) } : UNKNOWN
  }

  readonly list: ConfirmStore['list'] = (principal) => {
    if (principal.kind !== 'surface') return SURFACE_ONLY
    this.sweep()
    const items = [...this.records.values()]
      .map((r) => this.view(r))
      .filter((info) => info.state === 'pending')
      .reverse()
    return { ok: true, items }
  }

  readonly status: ConfirmStore['status'] = (principal, confirmId) => {
    const r = this.records.get(confirmId)
    if (!r || r.creator !== confirmCreatorKey(principal)) return UNKNOWN
    return { ok: true, info: this.view(r) }
  }

  readonly voidSession: ConfirmStore['voidSession'] = (sessionId) => {
    for (const r of this.records.values())
      if (r.sessionId === sessionId && r.state === 'pending') r.state = 'denied'
  }
}

export function createConfirmStore(options: ConfirmStoreOptions = {}): ConfirmStore {
  return new MemoryConfirmStore(options.now ?? Date.now, options.newId ?? randomUUID)
}
