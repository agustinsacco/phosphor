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
type TranscriptReadFailure =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: TranscriptUnreadableReason }
  | { kind: 'too-large' }
export type TranscriptReadResult =
  ({ kind: 'messages' } & Omit<TranscriptPreview, 'composer'>) | TranscriptReadFailure
type TranscriptReadWithComposer = ({ kind: 'messages' } & TranscriptPreview) | TranscriptReadFailure

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

type TranscriptReadOptions = {
  sessionFile: string
  sessionsRoot: string
  laneId: string
  cache: TranscriptCache
  onFailure: (reason: TranscriptFailureReason) => void
}

export function readTranscript(options: TranscriptReadOptions): TranscriptReadResult {
  const result = readTranscriptWithComposer(options)
  if (result.kind !== 'messages') return result
  const { composer: _composer, ...messages } = result
  return messages
}

/** Gets the saved composer and messages from the same verified, cached preview. */
export function readTranscriptWithComposer(
  options: TranscriptReadOptions,
): TranscriptReadWithComposer {
  // Invalidation and logging precede close, even when close itself throws.
  const failed = (reason: TranscriptFailureReason): TranscriptReadFailure => {
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
