import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
import { BRAIN_NEVER_READ_REFRESH_REFUSAL } from '@phosphor/shared/brain-review'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { CurrentLane, LaneFiles } from './lane-files'
import type { LaneEntry } from './transcript'
import { BRAIN_OWN_LANE_REFUSAL, isBrainOwnLane } from './agent/own-lane'

export interface LaneReadCheck {
  refusal: string | null
  /** The transcript, when the check had to read it; the read reuses it instead of reading again. */
  entries?: LaneEntry[]
  /** The check stored a changed title on the job. */
  retitled?: boolean
}

/**
 * The lane's current title, stored on the job when it changed. A title is bookkeeping: storing it
 * never bumps the knowledge revision, so it never stales a review.
 */
export async function currentTitle(
  store: BrainStore,
  files: LaneFiles,
  job: BrainJob,
): Promise<CurrentLane & { retitled: boolean }> {
  const current = await files.current(job.sessionPath)
  const stored = store.job(job.id)
  const retitled = stored !== undefined && stored.title !== current.title
  if (retitled) store.updateJob(job.id, { title: current.title })
  return { ...current, retitled }
}

/**
 * Eligibility follows the current transcript; an unreadable review stays available to reject.
 * `brainFolder`: Brain Agent's folder, whose lanes Brain never reads.
 */
export async function currentReadCheck(
  store: BrainStore,
  files: LaneFiles,
  job: BrainJob,
  brainFolder?: string,
): Promise<LaneReadCheck> {
  const prefs = () => store.snapshot().prefs.neverRead
  const byId = brainNeverReadReason({ ...prefs(), titles: [] }, job)
  if (byId) return { refusal: byId }
  const current = await currentTitle(store, files, job).catch((error: unknown) => {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (job.state === 'review' || job.state === 'refreshing' || store.storedProposal(job.id))
    )
      return null
    throw error
  })
  if (current === null) return { refusal: DELETED_LANE_REFRESH_REFUSAL }
  return {
    refusal: isBrainOwnLane(current.cwd, brainFolder)
      ? BRAIN_OWN_LANE_REFUSAL
      : brainNeverReadReason(prefs(), { ...job, title: current.title }),
    entries: current.entries,
    retitled: current.retitled,
  }
}

/** Shared, so the review page can tell it from the sentences that reload a review. */
export const NEVER_READ_REFRESH_REFUSAL = BRAIN_NEVER_READ_REFRESH_REFUSAL

export const DELETED_LANE_REFRESH_REFUSAL =
  "This lane was deleted, so this review can't be refreshed. Reject it."
