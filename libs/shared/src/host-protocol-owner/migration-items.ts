/**
 * Item parsers for `owner.migrate.import`: lanes, archive manifests and Claude
 * accounts, plus the bounded list and record helpers the sections share.
 * Reached through `../host-protocol-owner`.
 */
import { isIsoTime, isUuid } from '../control-api'
import {
  hex,
  integer,
  isLaneBranchName,
  label,
  member,
  record,
  text,
} from '../host-protocol/primitives'
import { isMachineAccountId } from '../machine-settings-fields'
import type { ClaudeAccount } from '../models/providers'

export const MIGRATION_LIMITS = {
  folders: 1000,
  lanes: 5000,
  archives: 1000,
  accounts: 32,
  pathChars: 4096,
} as const

export interface MigrationLaneItem {
  /** Minted by Desktop, so it can re-key the lane's drafts to `remoteLaneResourceKey`. */
  readonly laneId: string
  readonly sessionFile: string
  readonly cwd: string
  readonly rootPath: string
  readonly worktree: boolean
  /** `meta.name` or the first user text, as a lane title (80 characters). */
  readonly title: string | null
  readonly branch: string | null
  readonly model: { readonly provider: string; readonly id: string } | null
  /** The session header's timestamp; the daemon writes it as the lane's `created_at`. */
  readonly createdAt: string
  /** The session file's mtime. */
  readonly updatedAt: string
}

/**
 * A daemon archive record for a Desktop archive: a new lane UUID as `id`, the
 * migrated folder's `repositoryId`, the re-keyed draft key, and `cwd`,
 * `transcript`, `identity`, `checkout` and `worktree` byte-equal to Desktop's.
 */
export interface MigrationArchiveManifest {
  readonly version: 1
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly archivedAt: number
  readonly state: 'archiving' | 'archived' | 'restoring' | 'purging'
  readonly worktree?: boolean
  readonly transcript?: string
  readonly identity?: { readonly dev: number; readonly ino: number; readonly directory: string }
  readonly repository?: string
  readonly checkout?: { readonly dev: number; readonly ino: number; readonly path: string }
  readonly metadata: { readonly repositoryId: string; readonly draftKey?: string }
}

export const isOwnerPath = (v: unknown): v is string =>
  text(v, MIGRATION_LIMITS.pathChars) && v.startsWith('/') && !v.includes('\0')

export const isTrue = (v: unknown): v is true | undefined => v === undefined || v === true
export const optionalPath = (v: unknown): boolean => v === undefined || isOwnerPath(v)
const fileId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Keys pass `key`, values pass `value`, at most `max` entries; null otherwise. */
export function dict<T>(
  v: unknown,
  max: number,
  key: (k: string) => boolean,
  value: (x: unknown) => x is T,
): Record<string, T> | null {
  if (!record(v) || Object.keys(v).length > max) return null
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!key(k) || !value(x)) return null
    out[k] = x
  }
  return out
}
export function list<T>(v: unknown, max: number, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const x of v) {
    const item = parse(x)
    if (item === null) return null
    out.push(item)
  }
  return out
}

export function parseMigrationLaneItem(v: unknown): MigrationLaneItem | null {
  if (
    !record(v) ||
    !isUuid(v.laneId) ||
    !isOwnerPath(v.sessionFile) ||
    !isOwnerPath(v.cwd) ||
    !isOwnerPath(v.rootPath) ||
    typeof v.worktree !== 'boolean' ||
    (v.title !== null && !label(v.title)) ||
    (v.branch !== null && !isLaneBranchName(v.branch)) ||
    (v.model !== null &&
      (!record(v.model) || !text(v.model.provider, 200) || !text(v.model.id, 200))) ||
    !isIsoTime(v.createdAt) ||
    !isIsoTime(v.updatedAt)
  )
    return null
  return {
    laneId: v.laneId,
    sessionFile: v.sessionFile,
    cwd: v.cwd,
    rootPath: v.rootPath,
    worktree: v.worktree,
    title: v.title,
    branch: v.branch,
    model:
      record(v.model) && text(v.model.provider, 200) && text(v.model.id, 200)
        ? { provider: v.model.provider, id: v.model.id }
        : null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

function fileIdentity<K extends 'directory' | 'path'>(v: unknown, at: K) {
  return record(v) && fileId(v.dev) && fileId(v.ino) && isOwnerPath(v[at])
    ? ({ dev: v.dev, ino: v.ino, [at]: v[at] } as { dev: number; ino: number } & Record<K, string>)
    : null
}

export function parseMigrationArchiveManifest(v: unknown): MigrationArchiveManifest | null {
  if (!record(v) || v.version !== 1 || !isUuid(v.id) || !text(v.title, 200, 0)) return null
  const identity = v.identity === undefined ? undefined : fileIdentity(v.identity, 'directory')
  const checkout = v.checkout === undefined ? undefined : fileIdentity(v.checkout, 'path')
  const m = v.metadata
  if (
    !isOwnerPath(v.cwd) ||
    !integer(v.archivedAt) ||
    !member(v.state, ['archiving', 'archived', 'restoring', 'purging']) ||
    (v.worktree !== undefined && typeof v.worktree !== 'boolean') ||
    !optionalPath(v.transcript) ||
    !optionalPath(v.repository) ||
    identity === null ||
    checkout === null ||
    !record(m) ||
    !hex(m.repositoryId) ||
    (m.draftKey !== undefined && !text(m.draftKey, MIGRATION_LIMITS.pathChars))
  )
    return null
  return {
    version: 1,
    id: v.id,
    title: v.title,
    cwd: v.cwd,
    archivedAt: v.archivedAt,
    state: v.state,
    ...(typeof v.worktree === 'boolean' ? { worktree: v.worktree } : {}),
    ...(isOwnerPath(v.transcript) ? { transcript: v.transcript } : {}),
    ...(identity ? { identity } : {}),
    ...(isOwnerPath(v.repository) ? { repository: v.repository } : {}),
    ...(checkout ? { checkout } : {}),
    metadata: {
      repositoryId: m.repositoryId,
      ...(typeof m.draftKey === 'string' ? { draftKey: m.draftKey } : {}),
    },
  }
}

export function parseMigrationAccount(v: unknown, root: string): ClaudeAccount | null {
  const short = (x: unknown, max: number) => x === undefined || text(x, max)
  if (
    !record(v) ||
    !isMachineAccountId(v.id) ||
    !text(v.label, 320) ||
    !short(v.email, 320) ||
    !short(v.plan, 64) ||
    !short(v.organization, 200) ||
    !short(v.orgId, 128) ||
    (v.credentialDir !== null &&
      (typeof v.credentialDir !== 'string' ||
        !v.credentialDir.startsWith(`${root}/`) ||
        !isUuid(v.credentialDir.slice(root.length + 1)))) ||
    !integer(v.addedAt)
  )
    return null
  return {
    id: v.id,
    label: v.label,
    ...(typeof v.email === 'string' ? { email: v.email } : {}),
    ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
    ...(typeof v.organization === 'string' ? { organization: v.organization } : {}),
    ...(typeof v.orgId === 'string' ? { orgId: v.orgId } : {}),
    credentialDir: v.credentialDir,
    addedAt: v.addedAt,
  }
}
