import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { laneTitle } from './lane'
import { readLaneEntries } from './transcript'

/** Exclusions follow the current lane, not the title captured by an earlier read. */
export async function currentNeverReadReason(
  store: BrainStore,
  job: BrainJob,
): Promise<string | null> {
  const prefs = () => store.snapshot().prefs.neverRead
  const byId = brainNeverReadReason({ ...prefs(), titles: [] }, job)
  if (byId) return byId
  const entries = await readLaneEntries(job.sessionPath).catch((error: unknown) => {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (job.state === 'review' || job.state === 'refreshing' || store.storedProposal(job.id))
    )
      throw new Error(DELETED_LANE_REFRESH_REFUSAL)
    throw error
  })
  const title = laneTitle(entries) ?? ''
  return brainNeverReadReason(prefs(), { ...job, title })
}

export const NEVER_READ_REFRESH_REFUSAL =
  "Brain changed since this was read, and this lane is set to never be read, so it can't be refreshed. Reject it instead."

export const DELETED_LANE_REFRESH_REFUSAL =
  "This lane was deleted, so this review can't be refreshed. Reject it."
