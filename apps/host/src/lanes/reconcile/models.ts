/**
 * Lanes the Host never started have no model in their row: the one-time import
 * of This Mac's lanes sent none, and reconcile admits pi's sessions without
 * one. This fills each from the lane's transcript, once, on Host start; a lane
 * with a model is never touched, so it is a no-op once done.
 */
import type { HostStore } from '../store'
import {
  readRecordedModel,
  RECORDED_MODEL_TAIL_BYTES,
  type RecordedModel,
} from '../transcript/recorded-model'

/** All transcripts together; a lane past it waits for the next start. */
export const MODEL_REPAIR_BUDGET_BYTES = 128 * 1024 * 1024

export interface LaneModelCounts {
  repaired: number
  /** No session file, no model in the transcript's tail, or past the budget. */
  skipped: number
  unreadable: number
}

/** Reads each session file's model in turn, within one byte budget. */
export function recordedModelReader(sessionsRoot: string, budgetBytes: number) {
  let left = budgetBytes
  const counts: LaneModelCounts = { repaired: 0, skipped: 0, unreadable: 0 }
  return {
    counts,
    read(sessionFile: string | null): RecordedModel | null {
      if (sessionFile === null || left <= 0) {
        counts.skipped++
        return null
      }
      const read = readRecordedModel(
        sessionFile,
        sessionsRoot,
        Math.min(left, RECORDED_MODEL_TAIL_BYTES),
      )
      left -= read.bytes
      if (read.kind === 'model') return read.model
      counts[read.kind === 'none' ? 'skipped' : 'unreadable']++
      return null
    },
  }
}

export function repairLaneModels(
  store: HostStore,
  sessionsRoot: string,
  options: { budgetBytes?: number; signal?: AbortSignal } = {},
): LaneModelCounts {
  const reader = recordedModelReader(sessionsRoot, options.budgetBytes ?? MODEL_REPAIR_BUDGET_BYTES)
  for (const lane of store.listLanes()) {
    if (lane.model !== null) continue
    options.signal?.throwIfAborted()
    const model = reader.read(lane.sessionFile)
    if (!model) continue
    try {
      // The lane's recency is its own activity, not this repair.
      store.updateLane(lane.laneId, {
        provider: model.provider,
        model: model.id,
        updatedAt: lane.updatedAt,
      })
      reader.counts.repaired++
    } catch {
      reader.counts.unreadable++
    }
  }
  return reader.counts
}
