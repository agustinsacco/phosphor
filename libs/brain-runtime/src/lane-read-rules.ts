import { brainNeverReadReason, type BrainJob } from '@phosphor/shared/brain'
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
 * never bumps the knowledge revision.
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
 * Eligibility follows the current transcript.
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
    const proposal = store.storedProposal(job.id)
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      proposal &&
      proposal.computedRevision === store.knowledgeRevision()
    )
      return null
    throw error
  })
  if (!current) return { refusal: brainNeverReadReason(prefs(), job) }
  return {
    refusal: isBrainOwnLane(current.cwd, brainFolder)
      ? BRAIN_OWN_LANE_REFUSAL
      : brainNeverReadReason(prefs(), { ...job, title: current.title }),
    entries: current.entries,
    retitled: current.retitled,
  }
}
