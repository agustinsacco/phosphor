import type { AgentMessage } from '@phosphor/shared/rpc'

type CachedTranscript = { stamp: string; messages: AgentMessage[] }

/** Four successful lane reads, ordered by most recent use (including cache hits). */
export function createTranscriptCache() {
  const entries = new Map<string, CachedTranscript>()
  return {
    get(laneId: string, stamp: string): AgentMessage[] | undefined {
      const cached = entries.get(laneId)
      return cached?.stamp === stamp ? cached.messages : undefined
    },
    set(laneId: string, stamp: string, messages: AgentMessage[]): void {
      entries.delete(laneId)
      entries.set(laneId, { stamp, messages })
      if (entries.size > 4) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    delete(laneId: string): void {
      entries.delete(laneId)
    },
  }
}

export type TranscriptCache = ReturnType<typeof createTranscriptCache>
