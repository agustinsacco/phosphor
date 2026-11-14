import { isUuid } from './control-api'

/** Archives never expire automatically. Cleanup is an explicit, per-entry operation. */
export const ARCHIVE_WARNING_BYTES = 1_000_000_000
export interface LaneArchiveEntry {
  id: string
  title: string
  cwd: string
  archivedAt: number
  state: 'archiving' | 'archived' | 'restoring' | 'purging'
  /** Only dedicated worktrees are offered for removal; project roots are never removed. */
  worktree?: boolean
}
export interface LaneArchiveList {
  entries: LaneArchiveEntry[]
  bytes: number | null
  measuredAt: number | null
  measuring: boolean
  truncated: boolean
}
export type LaneArchiveOp =
  | { type: 'lane.archive'; laneId: string }
  | { type: 'archive.restore'; archiveId: string }
  | { type: 'archive.purge'; archiveId: string; removeWorktree: boolean }

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
export const isArchiveId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9-]{36,64}$/.test(v)
export function parseLaneArchiveOp(v: unknown): LaneArchiveOp | null {
  if (!record(v)) return null
  if (v.type === 'lane.archive' && isUuid(v.laneId) && Object.keys(v).length === 2)
    return { type: v.type, laneId: v.laneId }
  if (!isArchiveId(v.archiveId)) return null
  if (v.type === 'archive.restore' && Object.keys(v).length === 2)
    return { type: v.type, archiveId: v.archiveId }
  if (
    v.type === 'archive.purge' &&
    typeof v.removeWorktree === 'boolean' &&
    Object.keys(v).length === 3
  )
    return { type: v.type, archiveId: v.archiveId, removeWorktree: v.removeWorktree }
  return null
}

/** A bounded, metadata-only reply; never accept machine file paths as action authority. */
export function parseLaneArchiveList(v: unknown): LaneArchiveList | null {
  if (
    !record(v) ||
    !Array.isArray(v.entries) ||
    v.entries.length > 1000 ||
    typeof v.measuring !== 'boolean' ||
    typeof v.truncated !== 'boolean' ||
    (v.bytes !== null &&
      (typeof v.bytes !== 'number' || !Number.isSafeInteger(v.bytes) || v.bytes < 0)) ||
    (v.measuredAt !== null &&
      (typeof v.measuredAt !== 'number' || !Number.isSafeInteger(v.measuredAt) || v.measuredAt < 0))
  )
    return null
  const entries: LaneArchiveEntry[] = []
  for (const entry of v.entries) {
    if (
      !record(entry) ||
      !isArchiveId(entry.id) ||
      typeof entry.title !== 'string' ||
      entry.title.length > 200 ||
      typeof entry.cwd !== 'string' ||
      entry.cwd.length > 4096 ||
      typeof entry.archivedAt !== 'number' ||
      !Number.isSafeInteger(entry.archivedAt) ||
      !['archiving', 'archived', 'restoring', 'purging'].includes(String(entry.state)) ||
      (entry.worktree !== undefined && typeof entry.worktree !== 'boolean')
    )
      return null
    entries.push({
      id: entry.id,
      title: entry.title,
      cwd: entry.cwd,
      archivedAt: entry.archivedAt,
      state: entry.state as LaneArchiveEntry['state'],
      ...(entry.worktree === undefined ? {} : { worktree: entry.worktree as boolean }),
    })
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return null
  return {
    entries,
    bytes: v.bytes as number | null,
    measuredAt: v.measuredAt as number | null,
    measuring: v.measuring,
    truncated: v.truncated,
  }
}
