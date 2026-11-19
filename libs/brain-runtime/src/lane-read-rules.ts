import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { laneTitle } from './lane'
import { readEntries } from './transcript'

/** Exclusions follow the current lane, not the title captured by an earlier read. */
export async function currentNeverReadReason(
  store: BrainStore,
  job: BrainJob,
): Promise<string | null> {
  const prefs = () => store.snapshot().prefs.neverRead
  const byId = brainNeverReadReason({ ...prefs(), titles: [] }, job)
  if (byId) return byId
  const title = laneTitle(await readEntries(job.sessionPath)) ?? ''
  return brainNeverReadReason(prefs(), { ...job, title })
}

export const NEVER_READ_REFRESH_REFUSAL =
  "Brain changed since this was read, and this lane is set to never be read, so it can't be refreshed. Reject it instead."
