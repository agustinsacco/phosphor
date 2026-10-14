import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { AgentMessage } from '@phosphor/shared/rpc'
import type { LaneSummary, StreamCursor } from '@phosphor/shared/host-protocol'
import { parseSessionEntries, sessionContext } from '@phosphor/session-runtime/pi/session-context'
import { PI_MESSAGES_MAX } from './pi-results'
import { fitSnapshot, type SnapshotResult } from './projection-host'
import type { HostStore } from './store'

const FILE_BYTES = 64 * 1024 * 1024
type Reason = 'open' | 'type' | 'outside' | 'parse' | 'limit'
type Cached = { stamp: string; messages: AgentMessage[] }

export function createUnattachedSnapshots(options: {
  store: Pick<HostStore, 'getLane'>
  summary: (laneId: string) => LaneSummary | null
  cursor: (laneId: string) => StreamCursor
  sessionsRoot: string
  log: (message: string, data: { laneId: string; reason: Reason }) => void
}): (laneId: string) => SnapshotResult | null {
  const cache = new Map<string, Cached>()
  return (laneId) => {
    const lane = options.store.getLane(laneId)
    if (!lane || lane.removedAt !== null) {
      cache.delete(laneId)
      return null
    }
    const summary = options.summary(laneId)
    if (!summary) return null
    let messages: AgentMessage[] = []
    const unreadable = (reason: Reason): null => {
      cache.delete(laneId)
      options.log('lane.transcript_unreadable', { laneId, reason })
      return null
    }
    const limit = (): SnapshotResult => {
      unreadable('limit')
      return { ok: false, reason: 'too-large' }
    }
    if (lane.sessionFile !== null) {
      let fd: number
      try {
        fd = openSync(
          lane.sessionFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          return unreadable('open')
        cache.delete(laneId)
        return fitSnapshot({
          cursor: options.cursor(laneId),
          summary,
          state: null,
          messages,
          pending: [],
          dialogs: [],
          ui: [],
        })
      }
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile()) return unreadable('type')
        const canonical = realpathSync(lane.sessionFile)
        const path = relative(realpathSync(options.sessionsRoot), canonical)
        if (path === '..' || path.startsWith('../') || isAbsolute(path))
          return unreadable('outside')
        // A rename between open and realpath must not authorize a different descriptor.
        const resolved = statSync(canonical)
        if (resolved.dev !== stat.dev || resolved.ino !== stat.ino) return unreadable('open')
        if (stat.size > FILE_BYTES) return limit()
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
        const cached = cache.get(laneId)
        if (cached?.stamp === stamp) messages = cached.messages
        else {
          // The synchronous port is bounded by 64 MiB per read and four cached lanes.
          // Read at most one extra byte, so growth after fstat cannot cause an unbounded read.
          const buffer = Buffer.alloc(stat.size + 1)
          let size = 0
          while (size < buffer.length) {
            const count = readSync(fd, buffer, size, buffer.length - size, null)
            if (!count) break
            size += count
          }
          if (size > stat.size) return limit()
          const entries = parseSessionEntries(buffer.subarray(0, size).toString('utf8'))
          const context = entries && sessionContext(entries, PI_MESSAGES_MAX)
          if (!context) return unreadable('parse')
          messages = context.messages
        }
        cache.delete(laneId)
        cache.set(laneId, { stamp, messages })
        if (cache.size > 4) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
      } catch {
        return unreadable('open')
      } finally {
        closeSync(fd)
      }
    } else cache.delete(laneId)
    try {
      return fitSnapshot({
        cursor: options.cursor(laneId),
        summary,
        state: null,
        messages,
        pending: [],
        dialogs: [],
        ui: [],
      })
    } catch {
      return unreadable('parse')
    }
  }
}
