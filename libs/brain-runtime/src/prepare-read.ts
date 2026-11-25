import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { laneInfo, type LaneMeta } from './lane'
import { readLaneEntries, type LaneEntry } from './transcript'
import { readBoundary } from './incremental'

export interface PreparedRead extends LaneMeta {
  fromLeafId?: string | null
  alreadyKept?: string[]
  branched?: boolean
}

/**
 * Freeze both the lane and incremental context once: Resumed reads never re-read new input.
 * The transcript comes from the start check when it read one; otherwise it is read here, once,
 * after the saved checkpoint is looked up.
 */
export async function prepareRead(
  job: BrainJob,
  store: BrainStore,
  checked?: LaneEntry[],
): Promise<{ lane: PreparedRead; entries: LaneEntry[] }> {
  const saved = store.part(job.id, 'prepare', 'frozen-v4')
  const entries = checked ?? (await readLaneEntries(job.sessionPath))
  if (saved) return { lane: JSON.parse(saved.output) as PreparedRead, entries }
  const meta = await laneInfo(entries, store.snapshot().prefs.model)
  const boundary = readBoundary(entries, meta.leafId, job.fromLeafId)
  const lane: PreparedRead = {
    ...meta,
    ...boundary,
    alreadyKept: job.replaces || job.fromLeafId === null ? [] : store.laneContext(job.sessionId),
  }
  store.savePart(job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: JSON.stringify(lane),
    prepare: {
      leafId: lane.leafId,
      model: lane.model,
      branch: lane.branch,
      fromLeafId: boundary.fromLeafId,
    },
  })
  return { lane, entries }
}
