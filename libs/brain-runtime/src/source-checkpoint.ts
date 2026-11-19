import type { BrainStore, JobPart } from '@phosphor/memory-engine/types'

/** Frozen reads reuse validated source windows, including Retry and pre-upgrade recomputes.
 * Decision answers deliberately do not use this fallback: their complete prompt must match. */
export function sourceCheckpoint(
  store: BrainStore,
  jobId: string,
  part: string,
  hash: string,
): JobPart | undefined {
  return (
    store.part(jobId, part, hash) ??
    (store.storedProposal(jobId) || store.part(jobId, 'prepare')
      ? store.part(jobId, part)
      : undefined)
  )
}
