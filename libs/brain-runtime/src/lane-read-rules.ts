import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import { BRAIN_NEVER_READ_REFRESH_REFUSAL } from '@phosphor/shared/brain-review'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { LaneFiles } from './lane-files'
import type { LaneEntry } from './transcript'

export interface LaneReadCheck {
  refusal: string | null
  /** The transcript, when the check had to read it; the read reuses it instead of reading again. */
  entries?: LaneEntry[]
}

/** Eligibility follows the current transcript; an unreadable review stays available to reject. */
export async function currentReadCheck(
  store: BrainStore,
  files: LaneFiles,
  job: BrainJob,
): Promise<LaneReadCheck> {
  const prefs = () => store.snapshot().prefs.neverRead
  const byId = brainNeverReadReason({ ...prefs(), titles: [] }, job)
  if (byId) return { refusal: byId }
  const current = await files.current(job.sessionPath).catch((error: unknown) => {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (job.state === 'review' || job.state === 'refreshing' || store.storedProposal(job.id))
    )
      return null
    throw error
  })
  if (current === null) return { refusal: DELETED_LANE_REFRESH_REFUSAL }
  return {
    refusal: brainNeverReadReason(prefs(), { ...job, title: current.title }),
    entries: current.entries,
  }
}

/** Shared, so the review page can tell it from the sentences that reload a review. */
export const NEVER_READ_REFRESH_REFUSAL = BRAIN_NEVER_READ_REFRESH_REFUSAL

export const DELETED_LANE_REFRESH_REFUSAL =
  "This lane was deleted, so this review can't be refreshed. Reject it."
