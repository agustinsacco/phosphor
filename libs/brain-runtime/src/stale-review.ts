import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'

/** A refresh nobody waits for any more: the review waits, stale, until Brain Agent opens it. */
export function returnToReview(store: BrainStore, id: string): BrainJob {
  return store.updateJob(id, { state: 'review', runStartedAt: null, error: null, progress: null })
}

/**
 * At startup, refreshes left from before are not run (an older build refreshed every stale review
 * on its own). Returns how many reviews went back to waiting. A refreshing job with no stored
 * proposal has nothing to wait with, so it stays as it is.
 */
export function returnRefreshesToReview(store: BrainStore): number {
  const left = store
    .snapshot()
    .jobs.filter((job) => job.state === 'refreshing' && store.storedProposal(job.id))
  for (const job of left) returnToReview(store, job.id)
  return left.length
}
