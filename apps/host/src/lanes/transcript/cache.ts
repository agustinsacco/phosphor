import type { TranscriptPreview } from './preview'

type CachedTranscript = { stamp: string; preview: TranscriptPreview }

/** Four successful lane reads, ordered by most recent use (including cache hits). */
export function createTranscriptCache() {
  const entries = new Map<string, CachedTranscript>()
  return {
    get(laneId: string, stamp: string): TranscriptPreview | undefined {
      const cached = entries.get(laneId)
      return cached?.stamp === stamp ? cached.preview : undefined
    },
    set(laneId: string, stamp: string, preview: TranscriptPreview): void {
      entries.delete(laneId)
      entries.set(laneId, { stamp, preview })
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
