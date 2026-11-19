import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { readLane, type LaneMeta } from './lane'
import { readEntries } from './transcript'
import { readBoundary } from './incremental'

export interface PreparedRead extends LaneMeta {
  fromLeafId?: string | null
  alreadyKept?: string[]
  branched?: boolean
}

/** Freeze both the lane and incremental context once: Retry and refresh never re-read new input. */
export async function prepareRead(job: BrainJob, store: BrainStore): Promise<PreparedRead> {
  const saved = store.part(job.id, 'prepare', 'frozen-v4')
  if (saved) return JSON.parse(saved.output) as PreparedRead
  const meta = await readLane(job.sessionPath, store.snapshot().prefs.model)
  const boundary = readBoundary(await readEntries(job.sessionPath), meta.leafId, job.fromLeafId)
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
  return lane
}
