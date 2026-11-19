import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import { BRAIN_NEVER_READ_REFRESH_REFUSAL } from '@phosphor/shared/brain-review'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { laneTitle } from './lane'
import { readLaneEntries } from './transcript'

/** Eligibility follows the current transcript; an unreadable review stays available to reject. */
export async function currentReadRefusal(store: BrainStore, job: BrainJob): Promise<string | null> {
  const prefs = () => store.snapshot().prefs.neverRead
  const byId = brainNeverReadReason({ ...prefs(), titles: [] }, job)
  if (byId) return byId
  const entries = await readLaneEntries(job.sessionPath).catch((error: unknown) => {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (job.state === 'review' || job.state === 'refreshing' || store.storedProposal(job.id))
    )
      return null
    throw error
  })
  if (entries === null) return DELETED_LANE_REFRESH_REFUSAL
  const title = laneTitle(entries) ?? ''
  return brainNeverReadReason(prefs(), { ...job, title })
}

/** Shared, so the review page can tell it from the sentences that reload a review. */
export const NEVER_READ_REFRESH_REFUSAL = BRAIN_NEVER_READ_REFRESH_REFUSAL

export const DELETED_LANE_REFRESH_REFUSAL =
  "This lane was deleted, so this review can't be refreshed. Reject it."
