/**
 * Paged folder and lane lists, past the `lanes` topic's 64 folders and 1000
 * lanes. They are catalog ops over `ops.run` (`folder.list`, `lane.list`), served
 * to owner and surface principals by a Host that announces `ready.pagedLanes`.
 * The request's `page` carries the previous page's `next`; the result's `data`
 * is one of the pages below. The `lanes` topic keeps its bounds, because older
 * clients refuse a larger list.
 *
 * Pure module. Living contract: docs/remote-protocol.md ("Paged lanes").
 */
import { boundedList, parseLaneSummary, parseRepositorySummary } from './host-protocol/host-lanes'
import type { LaneSummary, RepositorySummary } from './host-protocol/lanes'
import { record, text } from './host-protocol/primitives'
import { OPS_LIMITS } from './host-protocol-ops'

export const PAGED_LANE_OPS = { folders: 'folder.list', lanes: 'lane.list' } as const

/** Page sizes keep a page within `OPS_LIMITS.callDataBytes`. */
export const PAGED_LANES_LIMITS = { foldersPerPage: 64, lanesPerPage: 200 } as const

export interface FolderListPage {
  readonly folders: readonly RepositorySummary[]
  /** Pass as the next request's `page`; null on the last page. */
  readonly next: string | null
}
export interface LaneListPage {
  readonly lanes: readonly LaneSummary[]
  readonly next: string | null
}

function next(v: unknown): string | null | undefined {
  if (v === null) return null
  return text(v, OPS_LIMITS.pageChars) && /^[A-Za-z0-9_-]+$/.test(v) ? v : undefined
}

export function parseFolderListPage(v: unknown): FolderListPage | null {
  if (!record(v)) return null
  const folders = boundedList(v.folders, PAGED_LANES_LIMITS.foldersPerPage, parseRepositorySummary)
  const n = next(v.next)
  return folders && n !== undefined ? { folders, next: n } : null
}

export function parseLaneListPage(v: unknown): LaneListPage | null {
  if (!record(v)) return null
  const lanes = boundedList(v.lanes, PAGED_LANES_LIMITS.lanesPerPage, parseLaneSummary)
  const n = next(v.next)
  return lanes && n !== undefined ? { lanes, next: n } : null
}
