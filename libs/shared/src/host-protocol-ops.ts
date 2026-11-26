/**
 * `ops.run`: the one wire for every agent-control catalog op. A read is a `call`
 * (`method: 'ops.run'`, `params: OpsRunRequest`); a write is a laneless, unfenced
 * `command` whose op is `{ type: 'ops.run', ...OpsRunRequest }`, answered by a
 * `done` receipt whose `data` is an `OpsRunResult`. Refusals the dispatcher
 * decides travel in band as `{ status: 'denied' }` on both paths; frame-level
 * refusals stay for malformed frames, and an older Host answers `unsupported`.
 *
 * Pure module. Living contract: docs/remote-protocol.md ("Agent ops").
 */
import { isSha256Hex, isUuid, normalizeLabel } from './control-api'
import { HOST_LIMITS } from './host-protocol/constants'
import { integer, member, record, text, utf8Length } from './host-protocol/primitives'
import { keys } from './machine-settings-fields'

export const OPS_RUN = 'ops.run'
export const OPS_MAX_PAGE_ROWS = 100

export const OPS_LIMITS = {
  /** UTF-8 bytes of the request's `args` JSON, any `content` argument included. */
  argsBytes: 300 * 1024,
  /** One content argument (file, skill or instructions text), UTF-8 bytes. */
  contentBytes: 256 * 1024,
  /** A command result and the tool text a lane receives, UTF-8 bytes of its JSON. */
  resultBytes: 64 * 1024,
  /** A call result's `data`, UTF-8 bytes of its JSON (artifact and transcript chunks). */
  callDataBytes: 1024 * 1024,
  reasonChars: 300,
  idsPerOp: 200,
  hostsPerBatch: 20,
  /** Hosts a batch reaches at once. */
  batchConcurrency: 4,
  confirmTtlMs: 600_000,
  /** An opaque page token. */
  pageChars: 256,
} as const

/** Catalog op names: one to three dot-separated camelCase words, at most 64 characters. */
export const OP_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,2}$/
export function isOpName(v: unknown): v is string {
  return text(v, 64) && OP_NAME_PATTERN.test(v)
}

/** When an op's effect is visible. */
export const OP_APPLIES = ['now', 'next-request', 'after-run', 'reload', 'new-lanes'] as const
export type OpApplies = (typeof OP_APPLIES)[number]

/** Attribution and a downgrade only: an actor never gains what its connection lacks. */
export interface OpsActor {
  readonly kind: 'agent'
  /** The asking lane's reference as its machine names it. */
  readonly lane?: string
  readonly title?: string
}
/** The run submission of an asked op. `digest` is lowercase SHA-256 hex of what was shown. */
export interface OpsConfirmRef {
  readonly confirmId: string
  readonly digest: string
}
/** One host's share of a batch the origin fans out (at most `hostsPerBatch`). */
export interface OpsBatchRef {
  readonly id: string
  readonly index: number
  readonly size: number
}
export interface OpsRunRequest {
  readonly op: string
  readonly args: Readonly<Record<string, unknown>>
  readonly reason?: string
  readonly actor?: OpsActor
  readonly confirm?: OpsConfirmRef
  readonly batch?: OpsBatchRef
  readonly page?: string
  readonly limit?: number
}
export type OpsRunOp = { readonly type: typeof OPS_RUN } & OpsRunRequest

/** One target of an asked op. Remote items in a batch carry their own confirm and digest. */
export interface ConfirmItem {
  /** The enrolled Host id; null means the machine that answered. */
  readonly hostId: string | null
  readonly op: string
  readonly ids: readonly string[]
  readonly labels: readonly string[]
  readonly confirmId?: string
  readonly digest?: string
}

export const OPS_DENY_CODES = [
  'unsupported',
  'never',
  'policy',
  'user-off',
  'limit',
  'unattended',
  'busy',
  'not-controller',
  'bad-request',
  'forbidden',
  'too-large',
  'unavailable',
  'confirm-denied',
  'confirm-expired',
  'confirm-mismatch',
] as const
export type OpsDenyCode = (typeof OPS_DENY_CODES)[number]

export type OpsRunResult =
  | {
      readonly status: 'ok'
      readonly text: string
      readonly applies: OpApplies
      readonly data?: unknown
      readonly next?: string
      readonly read?: true
      readonly undo?: boolean
      readonly auditId?: string
    }
  | {
      readonly status: 'confirm'
      readonly confirmId: string
      readonly digest: string
      readonly title: string
      readonly message: string
      readonly items: readonly ConfirmItem[]
      /** Epoch milliseconds. */
      readonly expiresAt: number
    }
  | {
      readonly status: 'denied'
      readonly code: OpsDenyCode
      readonly text: string
      readonly data?: unknown
    }

/** `data` of an op that may outlast the Host's answer deadline: poll `job.status`. */
export interface OpsJobData {
  readonly jobId: string
}

const token = (v: unknown, max: number): v is string => text(v, max) && /^[A-Za-z0-9_-]+$/.test(v)
const ref = (v: unknown): v is string => text(v, 256) && /^[!-~]+$/.test(v)
const jsonBytes = (v: unknown): number => {
  try {
    const s = JSON.stringify(v)
    return s === undefined ? Infinity : utf8Length(s)
  } catch {
    return Infinity
  }
}

function actor(v: unknown): OpsActor | null {
  if (!record(v) || v.kind !== 'agent' || !keys(v, ['kind', 'lane', 'title'])) return null
  if (v.lane !== undefined && !ref(v.lane)) return null
  if (v.title !== undefined && (typeof v.title !== 'string' || normalizeLabel(v.title) !== v.title))
    return null
  return {
    kind: 'agent',
    ...(v.lane !== undefined ? { lane: v.lane } : {}),
    ...(v.title !== undefined ? { title: v.title } : {}),
  }
}
export function parseOpsConfirmRef(v: unknown): OpsConfirmRef | null {
  return record(v) &&
    keys(v, ['confirmId', 'digest']) &&
    isUuid(v.confirmId) &&
    isSha256Hex(v.digest)
    ? { confirmId: v.confirmId, digest: v.digest }
    : null
}
function batchRef(v: unknown): OpsBatchRef | null {
  return record(v) &&
    keys(v, ['id', 'index', 'size']) &&
    isUuid(v.id) &&
    integer(v.size, 1) &&
    v.size <= OPS_LIMITS.hostsPerBatch &&
    integer(v.index) &&
    v.index < v.size
    ? { id: v.id, index: v.index, size: v.size }
    : null
}

const REQUEST_KEYS = ['op', 'args', 'reason', 'actor', 'confirm', 'batch', 'page', 'limit'] as const

/** Exact keys and bounded sizes. Args stay opaque here; the catalog validates them. */
export function parseOpsRunRequest(v: unknown): OpsRunRequest | null {
  if (!record(v) || !keys(v, [...REQUEST_KEYS]) || !isOpName(v.op)) return null
  if (!record(v.args) || jsonBytes(v.args) > OPS_LIMITS.argsBytes) return null
  if (v.reason !== undefined && !text(v.reason, OPS_LIMITS.reasonChars)) return null
  if (v.page !== undefined && !token(v.page, OPS_LIMITS.pageChars)) return null
  if (v.limit !== undefined && (!integer(v.limit, 1) || v.limit > OPS_MAX_PAGE_ROWS)) return null
  const a = v.actor === undefined ? undefined : actor(v.actor)
  const c = v.confirm === undefined ? undefined : parseOpsConfirmRef(v.confirm)
  const b = v.batch === undefined ? undefined : batchRef(v.batch)
  if (a === null || c === null || b === null) return null
  return {
    op: v.op,
    args: v.args,
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    ...(a ? { actor: a } : {}),
    ...(c ? { confirm: c } : {}),
    ...(b ? { batch: b } : {}),
    ...(v.page !== undefined ? { page: v.page } : {}),
    ...(v.limit !== undefined ? { limit: v.limit } : {}),
  }
}

/** The command form: `type` plus exactly the request's keys. */
export function parseOpsRunOp(v: Record<string, unknown>): OpsRunOp | null {
  if (v.type !== OPS_RUN) return null
  const { type: _type, ...rest } = v
  const request = parseOpsRunRequest(rest)
  return request ? { type: OPS_RUN, ...request } : null
}

function stringList(v: unknown, max: number, chars: number): string[] | null {
  return Array.isArray(v) && v.length <= max && v.every((x) => text(x, chars)) ? [...v] : null
}
function confirmItem(v: unknown): ConfirmItem | null {
  if (!record(v) || !keys(v, ['hostId', 'op', 'ids', 'labels', 'confirmId', 'digest'])) return null
  const ids = stringList(v.ids, OPS_LIMITS.idsPerOp, 128)
  const labels = stringList(v.labels, OPS_LIMITS.idsPerOp, 200)
  if (
    (v.hostId !== null && !isUuid(v.hostId)) ||
    !isOpName(v.op) ||
    !ids ||
    !labels ||
    labels.length !== ids.length ||
    (v.confirmId === undefined) !== (v.digest === undefined) ||
    (v.confirmId !== undefined && (!isUuid(v.confirmId) || !isSha256Hex(v.digest)))
  )
    return null
  return {
    hostId: v.hostId,
    op: v.op,
    ids,
    labels,
    ...(isUuid(v.confirmId) && isSha256Hex(v.digest)
      ? { confirmId: v.confirmId, digest: v.digest }
      : {}),
  }
}

function okResult(v: Record<string, unknown>): OpsRunResult | null {
  if (
    typeof v.text !== 'string' ||
    utf8Length(v.text) > OPS_LIMITS.resultBytes ||
    !member(v.applies, OP_APPLIES) ||
    (v.data !== undefined && jsonBytes(v.data) > OPS_LIMITS.callDataBytes) ||
    (v.next !== undefined && !text(v.next, HOST_LIMITS.messageChars)) ||
    (v.read !== undefined && v.read !== true) ||
    (v.undo !== undefined && typeof v.undo !== 'boolean') ||
    (v.auditId !== undefined && !token(v.auditId, HOST_LIMITS.idChars))
  )
    return null
  return {
    status: 'ok',
    text: v.text,
    applies: v.applies,
    ...(v.data !== undefined ? { data: v.data } : {}),
    ...(v.next !== undefined ? { next: v.next } : {}),
    ...(v.read === true ? { read: true as const } : {}),
    ...(v.undo !== undefined ? { undo: v.undo } : {}),
    ...(v.auditId !== undefined ? { auditId: v.auditId } : {}),
  }
}
function confirmResult(v: Record<string, unknown>): OpsRunResult | null {
  if (
    !isUuid(v.confirmId) ||
    !isSha256Hex(v.digest) ||
    !text(v.title, 200) ||
    typeof v.message !== 'string' ||
    utf8Length(v.message) > OPS_LIMITS.resultBytes ||
    !integer(v.expiresAt) ||
    !Array.isArray(v.items) ||
    v.items.length < 1 ||
    v.items.length > OPS_LIMITS.hostsPerBatch
  )
    return null
  const items = v.items.map(confirmItem)
  if (items.some((item) => item === null)) return null
  return {
    status: 'confirm',
    confirmId: v.confirmId,
    digest: v.digest,
    title: v.title,
    message: v.message,
    items: items.filter((item): item is ConfirmItem => item !== null),
    expiresAt: v.expiresAt,
  }
}

/** Unknown keys are dropped; an unknown status or deny code refuses the result. */
export function parseOpsRunResult(v: unknown): OpsRunResult | null {
  if (!record(v)) return null
  if (v.status === 'ok') return okResult(v)
  if (v.status === 'confirm') return confirmResult(v)
  if (v.status === 'denied')
    return member(v.code, OPS_DENY_CODES) &&
      text(v.text, HOST_LIMITS.messageChars) &&
      (v.data === undefined || jsonBytes(v.data) <= OPS_LIMITS.callDataBytes)
      ? {
          status: 'denied',
          code: v.code,
          text: v.text,
          ...(v.data !== undefined ? { data: v.data } : {}),
        }
      : null
  return null
}

export function parseOpsJobData(v: unknown): OpsJobData | null {
  return record(v) && token(v.jobId, HOST_LIMITS.idChars) ? { jobId: v.jobId } : null
}
