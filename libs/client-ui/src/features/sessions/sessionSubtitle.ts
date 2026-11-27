import type { GitInfo } from '@shared/models'
import { relativeTimeShort, absoluteTime } from '@/lib/time'

export interface SubtitleSegment {
  key: 'time' | 'dirty' | 'state'
  text: string
  /** Hover detail for a segment whose text is deliberately abbreviated. */
  tooltip?: string
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
 * Sidebar row subtitle: `2m · ±3`.
 *
 * No worktree or branch: every lane is a worktree on its own branch, and the
 * lane header already shows the branch. The dirty count comes from the
 * batched per-cwd git summary and may lag a refresh behind.
 *
 * **No spend here.** A per-lane dollar figure is a detail, not a way to pick a
 * lane, and it competed with the branch for the row's one truncating slot. It
 * lives where spending is the subject instead: the row's context menu, the
 * Home ledger, and the context meter's Cost row.
 */
export function sessionSubtitle(meta: SubtitleSource, git: GitInfo | undefined): SubtitleSegment[] {
  const segments: SubtitleSegment[] =
    meta.mtimeMs === undefined
      ? []
      : [
          {
            key: 'time',
            text: relativeTimeShort(meta.mtimeMs),
            // The row keeps the age short; the date and clock time the age was
            // compressed out of is one hover away, same as in the transcript.
            tooltip: absoluteTime(meta.mtimeMs),
          },
        ]
  if (meta.worktreeRemoved) segments.push({ key: 'state', text: 'worktree removed' })
  else if (meta.completedAt) segments.push({ key: 'state', text: 'finished' })
  if (!meta.worktreeRemoved && git?.isRepo && git.dirtyCount)
    segments.push({ key: 'dirty', text: `±${git.dirtyCount}` })
  return segments
}
