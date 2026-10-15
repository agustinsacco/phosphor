import { isUuid } from './control-api'

export type RepositoryOp =
  | { type: 'host.repositories.add'; path: string }
  | { type: 'host.repositories.remove'; repositoryId: string }
export type DeleteLaneOp = {
  type: 'lane.delete'
  laneId: string
  removeWorktree: boolean
  removeBranch: boolean
}
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
export const isHomePath = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 4096 &&
  (v === '' ||
    v
      .split('/')
      .every(
        (p) =>
          p.length > 0 &&
          !p.startsWith('.') &&
          !/[\\:]/.test(p) &&
          ![...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ))
export function parseFolderParams(v: unknown): { path?: string } | null {
  return record(v) && keys(v, ['path']) && (v.path === undefined || isHomePath(v.path))
    ? v.path === undefined
      ? {}
      : { path: v.path }
    : null
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
