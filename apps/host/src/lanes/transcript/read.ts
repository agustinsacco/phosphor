import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from 'node:fs'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { PreviewRefused } from './lines'
import { readPreview } from './preview'
import { errnoIs, isInside } from '@phosphor/session-runtime/fs-safety'
import type { TranscriptCache } from './cache'

const FILE_BYTES = 2 * 1024 ** 3
type TranscriptUnreadableReason = 'open' | 'type' | 'outside' | 'parse'
export type TranscriptFailureReason = TranscriptUnreadableReason | PreviewRefused['reason']
export type TranscriptReadResult =
  | { kind: 'messages'; messages: AgentMessage[] }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: TranscriptUnreadableReason }
  | { kind: 'too-large' }

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
    fd = openSync(
      options.sessionFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    return error instanceof Error && errnoIs(error, 'ENOENT') ? { kind: 'missing' } : failed('open')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return failed('type')
    const canonical = realpathSync(options.sessionFile)
    if (!isInside(realpathSync(options.sessionsRoot), canonical)) return failed('outside')
    // A rename between open and realpath must not authorize a different descriptor.
    const resolved = statSync(canonical)
    if (resolved.dev !== stat.dev || resolved.ino !== stat.ino) return failed('open')
    if (stat.size > FILE_BYTES) return failed('limit')
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    const cached = options.cache.get(options.laneId, stamp)
    const messages = cached ?? readPreview(fd, stat.size)
    options.cache.set(options.laneId, stamp, messages)
    return { kind: 'messages', messages }
  } catch (error) {
    return failed(error instanceof PreviewRefused ? error.reason : 'open')
  } finally {
    closeSync(fd)
  }
}
