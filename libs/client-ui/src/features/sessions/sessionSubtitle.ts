import type { GitInfo } from '@shared/models'
import { relativeTimeShort } from '@/lib/time'

export interface SubtitleSegment {
  key: 'time' | 'worktree' | 'branch' | 'dirty' | 'state'
  text: string
  /** The branch segment is the only one allowed to truncate. */
  truncate?: boolean
}

/**
 * The one field a subtitle needs, rather than a whole `SessionMeta`.
 *
 * A live session with no file on disk yet has no `SessionMeta` at all, and it
 * needs this same subtitle — pi writes no file until the first message is
 * sent, and the folder watcher reports it only after its debounce.
 */
export interface SubtitleSource {
  mtimeMs?: number
  worktreeRemoved?: boolean
  completedAt?: number
}

/**
 * Sidebar row subtitle: `2m · ⌥wt · ⎇ branch · ±3`.
 *
 * Everything after the timestamp is optional and data-driven; git segments
 * come from the batched per-cwd summary and may lag a refresh behind.
 *
 * **No spend here.** A per-lane dollar figure is a detail, not a way to pick a
 * lane, and it competed with the branch for the row's one truncating slot. It
 * lives where spending is the subject instead: the row's context menu, the
 * Home ledger, and the context meter's Cost row.
 */
export function sessionSubtitle(meta: SubtitleSource, git: GitInfo | undefined): SubtitleSegment[] {
  const segments: SubtitleSegment[] =
    meta.mtimeMs === undefined ? [] : [{ key: 'time', text: relativeTimeShort(meta.mtimeMs) }]
  if (meta.worktreeRemoved) segments.push({ key: 'state', text: 'worktree removed' })
  else if (meta.completedAt) segments.push({ key: 'state', text: 'finished' })
  if (!meta.worktreeRemoved && git?.isRepo) {
    if (git.isWorktree) segments.push({ key: 'worktree', text: 'wt' })
    if (git.branch) segments.push({ key: 'branch', text: git.branch, truncate: true })
    if (git.dirtyCount) segments.push({ key: 'dirty', text: `±${git.dirtyCount}` })
  }
  return segments
}
