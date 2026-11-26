import type { AgentMessage } from '@phosphor/shared/rpc'
import type { LaneSummary, StoppedComposer, StreamCursor } from '@phosphor/shared/host-protocol'
import { fitSnapshot, type SnapshotResult } from './projection-host'
import type { HostStore } from './store'
import { createTranscriptCache } from './transcript/cache'
import { readTranscriptWithComposer, type TranscriptFailureReason } from './transcript/read'

export function createUnattachedSnapshots(options: {
  store: Pick<HostStore, 'getLane'>
  summary: (laneId: string) => LaneSummary | null
  cursor: (laneId: string) => StreamCursor
  sessionsRoot: string
  window?: (laneId: string, model: NonNullable<LaneSummary['model']>) => number | undefined
  log: (message: string, data: { laneId: string; reason: TranscriptFailureReason }) => void
}): (laneId: string, mode?: 'complete' | 'composer') => SnapshotResult | null {
  const cache = createTranscriptCache()
  return (laneId, mode) => {
    const lane = options.store.getLane(laneId)
    if (!lane || lane.removedAt !== null) {
      cache.delete(laneId)
      return null
    }
    const summary = options.summary(laneId)
    if (!summary) return null
    let messages: AgentMessage[] = []
    let stoppedComposer: StoppedComposer | undefined
    const unreadable = (reason: TranscriptFailureReason): null => {
      cache.delete(laneId)
      options.log('lane.transcript_unreadable', { laneId, reason })
      return null
    }
    const snapshot = (): SnapshotResult =>
      fitSnapshot(
        {
          cursor: options.cursor(laneId),
          summary,
          state: null,
          ...(stoppedComposer ? { stoppedComposer } : {}),
          messages,
          pending: [],
          dialogs: [],
          ui: [],
        },
        mode !== 'complete',
      )
    if (lane.sessionFile !== null) {
      const result = readTranscriptWithComposer({
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
      if (mode === 'complete' && result.omitted) return { ok: false, reason: 'too-large' }
      // Detach publishes only the metadata; don't fit or serialize a history preview.
      if (mode !== 'composer') messages = result.messages
      const model = result.composer.model ?? summary.model
      const contextWindow = model ? options.window?.(laneId, model) : undefined
      const composer = {
        ...result.composer,
        ...(model ? { model } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      }
      if (Object.keys(composer).length) stoppedComposer = composer
    } else cache.delete(laneId)
    try {
      return snapshot()
    } catch {
      return unreadable('parse')
    }
  }
}
