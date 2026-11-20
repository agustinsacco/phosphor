import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainAgentMap } from '@phosphor/shared/brain-agent'
import type { BrainCuratorMethod } from '@phosphor/brain-client/validate-curator'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractionQueue } from '../queue'
import type { LaneFiles } from '../lane-files'
import type { BrainSearchPort, BrainServiceOptions } from '../types'
import type { Defrag } from './defrag'
import { READ_NOT_WAITING, type ReviewRefreshContext } from './review-refresh'

export const BRAIN_OFF = 'Brain is off. The owner can turn it on in Settings › Brain.'

export interface CuratorContext {
  store: BrainStore
  search: BrainSearchPort
  options: BrainServiceOptions
  queue: Pick<
    ExtractionQueue,
    'recompute' | 'refreshInline' | 'abortRefresh' | 'kick' | 'defragActive'
  >
  files: LaneFiles
  defrag: Pick<Defrag, 'turnRun'>
  changed(): void
  /** Brain is on, and neither resetting nor shutting down. Lane recall need not be on. */
  enabled(): boolean
  /** Overrides for tests: how long a read outside a run waits for the queue's refresh. */
  refreshWait?: Pick<ReviewRefreshContext, 'waitMs' | 'pollMs'>
}
/** Brain Agent's methods. Every one takes the asking call's signal, aborted when it hangs up. */
export type CuratorApi = {
  [M in BrainCuratorMethod | 'search']: (
    request: BrainAgentMap[M]['request'],
    signal: AbortSignal,
  ) => Promise<BrainAgentMap[M]['result']>
}

export function refreshContext(context: CuratorContext): ReviewRefreshContext {
  return {
    store: context.store,
    files: context.files,
    queue: context.queue,
    folder: context.options.agent?.folder,
    changed: context.changed,
    defragTurnSignal: () => context.defrag.turnRun()?.signal ?? null,
    ...context.refreshWait,
  }
}

/** A read in review or refreshing; anything else is not Brain Agent's to decide. */
export function waitingRead(store: BrainStore, jobId: string): BrainJob {
  const job = store.job(jobId)
  if (
    !job ||
    (job.state !== 'review' && job.state !== 'refreshing') ||
    !store.storedProposal(jobId)
  )
    throw new Error(READ_NOT_WAITING)
  return job
}
