/**
 * Parameter parsers for every owner call except `owner.migrate.import`
 * (./migration.ts). Each returns null for invalid params. Unknown keys are
 * dropped. Reached through `../host-protocol-owner`.
 */
import { isUuid, isVersion, normalizeLabel } from '../control-api'
import { integer, record, text } from '../host-protocol/primitives'
import { isOwnerPath } from './migration-items'
import type { AppServiceRegistration } from './status'

export const OWNER_LIMITS = {
  /**
   * Owner calls may run this long before the daemon answers `internal`. Import
   * and commit do real disk work; HOST_LIMITS.commandAnswerMs stays for others.
   */
  callAnswerMs: 120_000,
  indexLanesPerPage: 500,
  leasePaths: 64,
  leaseTtlMs: 600_000,
  pauseDeadlineMs: 600_000,
  /** One transcript page's `text`, UTF-8 bytes; a page fits a Host frame after escaping. */
  transcriptPageBytes: 4 * 1024 * 1024,
  /** Largest session file an owner pages through. This Mac's largest is 330 MiB. */
  transcriptFileBytes: 2 * 1024 * 1024 * 1024,
  pageTokenChars: 256,
  appServiceTokenChars: 256,
} as const

/** Params that must be absent: undefined and `{}` both pass. */
export const noParams = (v: unknown): undefined | null =>
  v === undefined || (record(v) && Object.keys(v).length === 0) ? undefined : null

export const migrationRef = (v: unknown): { migrationId: string } | null =>
  record(v) && isUuid(v.migrationId) ? { migrationId: v.migrationId } : null

export const leaseRef = (v: unknown): { leaseId: string } | null =>
  record(v) && isUuid(v.leaseId) ? { leaseId: v.leaseId } : null

export const accountRef = (v: unknown): { accountId: string } | null =>
  record(v) && isUuid(v.accountId) ? { accountId: v.accountId } : null

export function action<A extends string>(v: unknown, actions: readonly A[]): { action: A } | null {
  return record(v) && actions.some((a) => a === v.action) ? { action: v.action as A } : null
}

export function pauseParams(
  v: unknown,
):
  | { action: 'begin'; purpose: 'update'; deadlineMs?: number }
  | { action: 'abort-now' }
  | { action: 'cancel' }
  | null {
  if (!record(v)) return null
  if (v.action === 'abort-now' || v.action === 'cancel') return { action: v.action }
  if (v.action !== 'begin' || v.purpose !== 'update') return null
  if (v.deadlineMs === undefined) return { action: 'begin', purpose: 'update' }
  return integer(v.deadlineMs, 1) && v.deadlineMs <= OWNER_LIMITS.pauseDeadlineMs
    ? { action: 'begin', purpose: 'update', deadlineMs: v.deadlineMs }
    : null
}

export function appService(v: unknown): AppServiceRegistration | null {
  if (!record(v) || v.service !== 'brain' || typeof v.recall !== 'boolean') return null
  const m =
    typeof v.endpoint === 'string'
      ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(v.endpoint)
      : null
  if (!m || Number(m[1]) > 65535) return null
  if (!text(v.token, OWNER_LIMITS.appServiceTokenChars) || !/^[!-~]+$/.test(v.token)) return null
  return {
    service: 'brain',
    endpoint: `http://127.0.0.1:${m[1]}`,
    token: v.token,
    recall: v.recall,
  }
}

export function indexParams(v: unknown): { after?: string } | null {
  if (v === undefined) return {}
  if (!record(v)) return null
  if (v.after === undefined) return {}
  return text(v.after, OWNER_LIMITS.pageTokenChars) && /^[A-Za-z0-9_-]+$/.test(v.after)
    ? { after: v.after }
    : null
}

export function beginParams(
  v: unknown,
): { migrationId: string; desktopVersion: string; merge?: true } | null {
  const ref = migrationRef(v)
  if (!ref || !record(v) || !isVersion(v.desktopVersion)) return null
  if (v.merge !== undefined && v.merge !== true) return null
  return { ...ref, desktopVersion: v.desktopVersion, ...(v.merge ? { merge: true as const } : {}) }
}

export function leaseTakeParams(v: unknown): { paths: string[]; ttlMs: number } | null {
  if (!record(v) || !Array.isArray(v.paths) || !integer(v.ttlMs, 1)) return null
  const paths: unknown[] = v.paths
  if (
    paths.length < 1 ||
    paths.length > OWNER_LIMITS.leasePaths ||
    !paths.every(isOwnerPath) ||
    v.ttlMs > OWNER_LIMITS.leaseTtlMs
  )
    return null
  return { paths: paths.filter(isOwnerPath), ttlMs: v.ttlMs }
}

export function transcriptParams(
  v: unknown,
): { laneId: string; offset: number; maxBytes?: number } | null {
  if (!record(v) || !isUuid(v.laneId) || !integer(v.offset)) return null
  if (v.offset > OWNER_LIMITS.transcriptFileBytes) return null
  if (v.maxBytes === undefined) return { laneId: v.laneId, offset: v.offset }
  return integer(v.maxBytes, 1) && v.maxBytes <= OWNER_LIMITS.transcriptPageBytes
    ? { laneId: v.laneId, offset: v.offset, maxBytes: v.maxBytes }
    : null
}

export interface AccountRegistration {
  readonly accountId: string
  readonly label: string
  readonly email?: string
  readonly plan?: string
  readonly organization?: string
  readonly orgId?: string
}

/** No path: the daemon registers the folder it issued for `accountId`. */
export function accountRegistration(v: unknown): AccountRegistration | null {
  const ref = accountRef(v)
  if (!ref || !record(v) || typeof v.label !== 'string' || normalizeLabel(v.label) !== v.label)
    return null
  const extra: Record<string, string> = {}
  for (const [key, max] of [
    ['email', 320],
    ['plan', 64],
    ['organization', 200],
    ['orgId', 128],
  ] as const) {
    const value = v[key]
    if (value === undefined) continue
    if (!text(value, max)) return null
    extra[key] = value
  }
  return { ...ref, label: v.label, ...extra }
}
