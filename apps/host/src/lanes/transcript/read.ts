import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { parseSessionEntries, sessionContext } from '@phosphor/session-runtime/pi/session-context'
import { errnoIs, isInside } from '../../fs-safety'
import { PI_MESSAGES_MAX } from '../pi-results'
import type { TranscriptCache } from './cache'

const FILE_BYTES = 64 * 1024 * 1024
type TranscriptUnreadableReason = 'open' | 'type' | 'outside' | 'parse'
export type TranscriptFailureReason = TranscriptUnreadableReason | 'limit'
export type TranscriptReadResult =
  | { kind: 'messages'; messages: AgentMessage[] }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: TranscriptUnreadableReason }
  | { kind: 'too-large' }

function readMessages(fd: number, size: number): TranscriptReadResult {
  // One extra byte detects growth after fstat without allowing an unbounded read.
  const buffer = Buffer.alloc(size + 1)
  let bytes = 0
  while (bytes < buffer.length) {
    const count = readSync(fd, buffer, bytes, buffer.length - bytes, null)
    if (!count) break
    bytes += count
  }
  if (bytes > size) return { kind: 'too-large' }
  const entries = parseSessionEntries(buffer.subarray(0, bytes).toString('utf8'))
  const context = entries && sessionContext(entries, PI_MESSAGES_MAX)
  return context
    ? { kind: 'messages', messages: context.messages }
    : { kind: 'unreadable', reason: 'parse' }
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
    return reason === 'limit' ? { kind: 'too-large' } : { kind: 'unreadable', reason }
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
    const result: TranscriptReadResult = cached
      ? { kind: 'messages', messages: cached }
      : readMessages(fd, stat.size)
    if (result.kind === 'too-large') return failed('limit')
    if (result.kind === 'unreadable') return failed(result.reason)
    if (result.kind === 'messages') options.cache.set(options.laneId, stamp, result.messages)
    return result
  } catch {
    return failed('open')
  } finally {
    closeSync(fd)
  }
}
