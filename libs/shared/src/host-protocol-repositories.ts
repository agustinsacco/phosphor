import { isUuid } from './control-api'
import { HOST_LIMITS } from './host-protocol/constants'

export type RepositoryOp =
  | { type: 'host.repositories.add'; path: string }
  | { type: 'host.repositories.remove'; repositoryId: string }
  /** Makes one new folder; its parent must already exist. Never adds it to the config. */
  | { type: 'host.repositories.createFolder'; path: string }
  /** Every active repository's id, once each, in the order the Host should list them. */
  | { type: 'host.repositories.order'; repositoryIds: string[] }
export type DeleteLaneOp = {
  type: 'lane.delete'
  laneId: string
  removeWorktree: boolean
  removeBranch: boolean
}
/** Fixed refusals main passes to the renderer, which shows only these verbatim. */
export const FOLDER_EXISTS = 'A folder with that name already exists.'
export const HOST_TOO_OLD = 'Update the Host on this machine first: run phosphor update there.'
export interface FolderList {
  path: string
  truncated: boolean
  entries: { name: string; isRepository: boolean; configured: boolean }[]
}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
export const isRepositoryId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{16}$/.test(v)
/**
 * A path relative to the Host user's home. Hidden names such as `.config` are
 * allowed; `.` and `..` never are. Older Hosts refuse every dot name and older
 * Desktops refuse one in a listing, so a listing includes hidden folders only
 * when asked.
 */
export const isHomePath = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 4096 &&
  (v === '' ||
    v
      .split('/')
      .every(
        (p) =>
          p.length > 0 &&
          p !== '.' &&
          p !== '..' &&
          !/[\\:]/.test(p) &&
          ![...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ))
/** One new folder's name: a single home-path component of at most 255 characters. */
export const isFolderName = (v: unknown): v is string =>
  isHomePath(v) && v !== '' && !v.includes('/') && v.length <= 255
export function parseFolderParams(v: unknown): { path?: string; hidden?: true } | null {
  if (
    !record(v) ||
    !keys(v, ['path', 'hidden']) ||
    (v.path !== undefined && !isHomePath(v.path)) ||
    (v.hidden !== undefined && typeof v.hidden !== 'boolean')
  )
    return null
  return {
    ...(v.path === undefined ? {} : { path: v.path as string }),
    ...(v.hidden === true ? { hidden: true as const } : {}),
  }
}
export function parseRepositoryOp(v: unknown): RepositoryOp | null {
  if (!record(v)) return null
  if (v.type === 'host.repositories.add' && keys(v, ['type', 'path']) && isHomePath(v.path))
    return { type: v.type, path: v.path }
  if (
    v.type === 'host.repositories.remove' &&
    keys(v, ['type', 'repositoryId']) &&
    isRepositoryId(v.repositoryId)
  )
    return { type: v.type, repositoryId: v.repositoryId }
  if (
    v.type === 'host.repositories.createFolder' &&
    keys(v, ['type', 'path']) &&
    isHomePath(v.path) &&
    isFolderName(v.path.split('/').pop())
  )
    return { type: v.type, path: v.path }
  if (
    v.type === 'host.repositories.order' &&
    keys(v, ['type', 'repositoryIds']) &&
    Array.isArray(v.repositoryIds) &&
    v.repositoryIds.length > 0 &&
    v.repositoryIds.length <= HOST_LIMITS.repositoriesPerHost &&
    v.repositoryIds.every(isRepositoryId) &&
    new Set(v.repositoryIds).size === v.repositoryIds.length
  )
    return { type: v.type, repositoryIds: [...(v.repositoryIds as string[])] }
  return null
}
export function parseDeleteLaneOp(v: unknown): DeleteLaneOp | null {
  return record(v) &&
    v.type === 'lane.delete' &&
    keys(v, ['type', 'laneId', 'removeWorktree', 'removeBranch']) &&
    isUuid(v.laneId) &&
    typeof v.removeWorktree === 'boolean' &&
    typeof v.removeBranch === 'boolean'
    ? {
        type: v.type,
        laneId: v.laneId,
        removeWorktree: v.removeWorktree,
        removeBranch: v.removeBranch,
      }
    : null
}
export function parseFolderList(v: unknown): FolderList | null {
  if (
    !record(v) ||
    !keys(v, ['path', 'truncated', 'entries']) ||
    !isHomePath(v.path) ||
    typeof v.truncated !== 'boolean' ||
    !Array.isArray(v.entries) ||
    v.entries.length > 500
  )
    return null
  const entries: FolderList['entries'] = []
  for (const entry of v.entries) {
    if (
      !record(entry) ||
      !keys(entry, ['name', 'isRepository', 'configured']) ||
      typeof entry.name !== 'string' ||
      entry.name.length > 255 ||
      !isHomePath(entry.name) ||
      entry.name.includes('/') ||
      typeof entry.isRepository !== 'boolean' ||
      typeof entry.configured !== 'boolean'
    )
      return null
    entries.push({
      name: entry.name,
      isRepository: entry.isRepository,
      configured: entry.configured,
    })
  }
  return { path: v.path, truncated: v.truncated, entries }
}

export function parseDeleteLaneResult(v: unknown): { branchKept: boolean } | null {
  return record(v) && keys(v, ['branchKept']) && typeof v.branchKept === 'boolean'
    ? { branchKept: v.branchKept }
    : null
}
