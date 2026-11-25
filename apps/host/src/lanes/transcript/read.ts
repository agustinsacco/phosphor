import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs'
import { PreviewRefused } from './lines'
import { readPreview, type TranscriptPreview } from './preview'
import { errnoIs, isInside } from '@phosphor/session-runtime/fs-safety'
import { TRANSCRIPT_FILE_MAX_BYTES } from '@phosphor/session-runtime/pi/session-context'
import type { TranscriptCache } from './cache'

export type TranscriptUnreadableReason = 'open' | 'type' | 'outside' | 'parse'
export type TranscriptFailureReason = TranscriptUnreadableReason | PreviewRefused['reason']
export type TranscriptReadResult =
  | ({ kind: 'messages' } & TranscriptPreview)
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: TranscriptUnreadableReason }
  | { kind: 'too-large' }

/** Opens a session file read-only, never following a link; throws as fs does. */
export const openTranscriptFile = (sessionFile: string): number =>
  openSync(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)

/**
 * The open descriptor's stat, once it is a regular file inside pi's sessions
 * root and still the file at `sessionFile`; otherwise why not. A filesystem
 * error throws, for the caller to treat as an open failure.
 */
export function verifyTranscriptFile(
  fd: number,
  sessionFile: string,
  sessionsRoot: string,
): Stats | TranscriptUnreadableReason {
  const stat = fstatSync(fd)
  if (!stat.isFile()) return 'type'
  const canonical = realpathSync(sessionFile)
  if (!isInside(realpathSync(sessionsRoot), canonical)) return 'outside'
  // A rename between open and realpath must not authorize a different descriptor.
  const resolved = statSync(canonical)
  if (resolved.dev !== stat.dev || resolved.ino !== stat.ino) return 'open'
  return stat
}

export function readTranscript(options: {
  sessionFile: string
  sessionsRoot: string
  laneId: string
  cache: TranscriptCache
  onFailure: (reason: TranscriptFailureReason) => void
}): TranscriptReadResult {
  // Invalidation and logging precede close, even when close itself throws.
  const failed = (reason: TranscriptFailureReason): TranscriptReadResult => {
    options.onFailure(reason)
    return reason === 'limit' || reason === 'line-limit' || reason === 'index-limit'
      ? { kind: 'too-large' }
      : { kind: 'unreadable', reason }
  }
  let fd: number
  try {
    fd = openTranscriptFile(options.sessionFile)
  } catch (error) {
    return error instanceof Error && errnoIs(error, 'ENOENT') ? { kind: 'missing' } : failed('open')
  }
  try {
    const stat = verifyTranscriptFile(fd, options.sessionFile, options.sessionsRoot)
    if (typeof stat === 'string') return failed(stat)
    if (stat.size > TRANSCRIPT_FILE_MAX_BYTES) return failed('limit')
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    const cached = options.cache.get(options.laneId, stamp)
    const preview = cached ?? readPreview(fd, stat.size)
    options.cache.set(options.laneId, stamp, preview)
    return { kind: 'messages', ...preview }
  } catch (error) {
    return failed(error instanceof PreviewRefused ? error.reason : 'open')
  } finally {
    closeSync(fd)
  }
}
