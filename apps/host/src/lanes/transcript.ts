import type { AgentMessage } from '@phosphor/shared/rpc'
import type { LaneSummary, StreamCursor } from '@phosphor/shared/host-protocol'
import { fitSnapshot, type SnapshotResult } from './projection-host'
import type { HostStore } from './store'
import { createTranscriptCache } from './transcript/cache'
import { readTranscript, type TranscriptFailureReason } from './transcript/read'

export function createUnattachedSnapshots(options: {
  store: Pick<HostStore, 'getLane'>
  summary: (laneId: string) => LaneSummary | null
  cursor: (laneId: string) => StreamCursor
  sessionsRoot: string
  log: (message: string, data: { laneId: string; reason: TranscriptFailureReason }) => void
}): (laneId: string) => SnapshotResult | null {
  const cache = createTranscriptCache()
  return (laneId) => {
    const lane = options.store.getLane(laneId)
    if (!lane || lane.removedAt !== null) {
      cache.delete(laneId)
      return null
    }
    const summary = options.summary(laneId)
    if (!summary) return null
    let messages: AgentMessage[] = []
    const unreadable = (reason: TranscriptFailureReason): null => {
      cache.delete(laneId)
      options.log('lane.transcript_unreadable', { laneId, reason })
      return null
    }
    const snapshot = (): SnapshotResult =>
      fitSnapshot({
        cursor: options.cursor(laneId),
        summary,
        state: null,
        messages,
        pending: [],
        dialogs: [],
        ui: [],
      })
    if (lane.sessionFile !== null) {
      const result = readTranscript({
        sessionFile: lane.sessionFile,
        sessionsRoot: options.sessionsRoot,
        laneId,
        cache,
        onFailure: unreadable,
      })
      if (result.kind === 'unreadable') return null
      if (result.kind === 'too-large') return { ok: false, reason: 'too-large' }
      if (result.kind === 'missing') {
        cache.delete(laneId)
        return snapshot()
      }
      messages = result.messages
    } else cache.delete(laneId)
    try {
      return snapshot()
    } catch {
      return unreadable('parse')
    }
  }
}
