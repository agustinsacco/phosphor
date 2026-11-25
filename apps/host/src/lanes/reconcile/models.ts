/**
 * Lanes the Host never started have no model in their row: the one-time import
 * of This Mac's lanes sent none, and reconcile admits pi's sessions without
 * one. This fills each from the lane's transcript on Host start, newest lanes
 * first; a lane with a model is never touched. A lane read in full without a
 * result is remembered by its file's size and mtime, so the next start reads
 * it again only once the file changes, and spends its budget further on.
 */
import { lstatSync } from 'node:fs'
import type { HostStore, StoredLane } from '../store'
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

/** `settled`: the whole tail was read and holds no model, so the same file never will. */
export type LaneModelRead = { model: RecordedModel } | { model: null; settled: boolean }

/** Reads each session file's model in turn, within one byte budget. */
export function recordedModelReader(
  sessionsRoot: string,
  budgetBytes: number,
  tailBytes = RECORDED_MODEL_TAIL_BYTES,
) {
  let left = budgetBytes
  const counts: LaneModelCounts = { repaired: 0, skipped: 0, unreadable: 0 }
  return {
    counts,
    read(sessionFile: string | null): LaneModelRead {
      if (sessionFile === null || left <= 0) {
        counts.skipped++
        return { model: null, settled: false }
      }
      const allowance = Math.min(left, tailBytes)
      const read = readRecordedModel(sessionFile, sessionsRoot, allowance)
      left -= read.bytes
      if (read.kind === 'model') return { model: read.model }
      counts[read.kind === 'none' ? 'skipped' : 'unreadable']++
      return { model: null, settled: read.kind === 'none' && allowance === tailBytes }
    },
  }
}

/** A session file's identity for `scanned`: its size and mtime, or null when it is not a file. */
function fileStamp(sessionFile: string | null): string | null {
  if (sessionFile === null) return null
  try {
    const stat = lstatSync(sessionFile, { throwIfNoEntry: false })
    return stat?.isFile() ? `${stat.size}:${stat.mtimeMs}` : null
  } catch {
    return null
  }
}

const newestFirst = (a: StoredLane, b: StoredLane) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.laneId.localeCompare(b.laneId)

export interface LaneModelRepair {
  /** `unchanged`: remembered lanes whose file has not changed, not read again. */
  counts: LaneModelCounts & { unchanged: number }
  /** Lanes read in full without a result, by id: their file's `size:mtimeMs`. */
  scanned: Map<string, string>
}

export function repairLaneModels(
  store: HostStore,
  sessionsRoot: string,
  options: {
    budgetBytes?: number
    tailBytes?: number
    signal?: AbortSignal
    scanned?: ReadonlyMap<string, string>
  } = {},
): LaneModelRepair {
  const reader = recordedModelReader(
    sessionsRoot,
    options.budgetBytes ?? MODEL_REPAIR_BUDGET_BYTES,
    options.tailBytes,
  )
  const scanned = new Map<string, string>()
  let unchanged = 0
  for (const lane of store.listLanes().sort(newestFirst)) {
    if (lane.model !== null) continue
    options.signal?.throwIfAborted()
    const stamp = fileStamp(lane.sessionFile)
    if (stamp !== null && options.scanned?.get(lane.laneId) === stamp) {
      scanned.set(lane.laneId, stamp)
      unchanged++
      continue
    }
    const read = reader.read(lane.sessionFile)
    if (!read.model) {
      if (read.settled && stamp !== null) scanned.set(lane.laneId, stamp)
      continue
    }
    try {
      // The lane's recency is its own activity, not this repair.
      store.updateLane(lane.laneId, {
        provider: read.model.provider,
        model: read.model.id,
        updatedAt: lane.updatedAt,
      })
      reader.counts.repaired++
    } catch {
      reader.counts.unreadable++
    }
  }
  return { counts: { ...reader.counts, unchanged }, scanned }
}

/**
 * After a branch change on a stopped lane: its row takes the model its
 * transcript now resumes with, or none when the branch's tail names none, so
 * the stopped chip shows what resume will pick. An unreadable file leaves the
 * row as it was. The lane's recency is unchanged. True when the row changed.
 */
export function rederiveLaneModel(store: HostStore, sessionsRoot: string, laneId: string): boolean {
  const lane = store.getLane(laneId)
  if (!lane || lane.removedAt !== null || lane.sessionFile === null) return false
  const read = readRecordedModel(lane.sessionFile, sessionsRoot)
  if (read.kind === 'unreadable') return false
  const model = read.kind === 'model' ? read.model : null
  if (model?.provider === lane.model?.provider && model?.id === lane.model?.id) return false
  store.updateLane(laneId, {
    provider: model?.provider ?? null,
    model: model?.id ?? null,
    updatedAt: lane.updatedAt,
  })
  return true
}
