import { setTimeout as delay } from 'node:timers/promises'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractionQueue } from '../queue'
import type { LaneFiles } from '../lane-files'
import { currentReadCheck } from '../lane-read-rules'

export const READ_NOT_WAITING = 'This read is not waiting for a decision.'
export const READ_STILL_REFRESHING =
  'This read is still refreshing because Brain changed since it was read. Try it again in a few minutes.'
export const READ_NOW_EMPTY =
  'After Brain changed, this read has nothing left to save, so there is nothing to decide.'

export interface ReviewRefreshContext {
  store: BrainStore
  files: LaneFiles
  queue: Pick<ExtractionQueue, 'recompute' | 'refreshInline' | 'defragActive'>
  /** Brain Agent's folder, whose lanes Brain never reads. */
  folder?: string
  /** The lane check stored a changed title on the job. */
  changed?(): void
  /**
   * Defrag's Stop signal while Brain Agent answers its message, or null: outside a run, and while
   * the run waits for the owner's own turn, whose refresh Stop leaves alone.
   */
  defragTurnSignal(): AbortSignal | null
  /** Outside a run, how long to wait for the queue's own refresh. */
  waitMs?: number
  pollMs?: number
}

const WAIT_MS = 10 * 60_000
const POLL_MS = 500

/** Brain changed since the read, or the queue is refreshing it. */
export function reviewStale(store: BrainStore, id: string): boolean {
  const job = store.job(id)
  const proposal = store.storedProposal(id)
  return (
    !!job &&
    !!proposal &&
    (job.state === 'refreshing' || proposal.computedRevision !== store.knowledgeRevision())
  )
}

/**
 * Brings a waiting read up to date before Brain Agent reads or decides it. While Defrag holds the
 * worker it refreshes inline, so a queued refresh never waits behind the run; otherwise the queue
 * refreshes it and this waits, at most ten minutes. Never a second model run. Returns the refusal when the lane
 * may not be read as it is now (never read, Brain's own lane, deleted), fresh or stale: renaming
 * a lane changes no knowledge. Its review stays as it is, to reject.
 */
export async function freshReview(
  context: ReviewRefreshContext,
  id: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { store, files, queue } = context
  const check = async (): Promise<string | null> => {
    const job = store.job(id)
    if (!job) return null
    const { refusal, retitled } = await currentReadCheck(store, files, job, context.folder)
    if (retitled) context.changed?.()
    return refusal
  }
  const refusal = await check()
  if (refusal || !reviewStale(store, id)) return refusal
  if (queue.defragActive) {
    const stop = context.defragTurnSignal()
    await queue.refreshInline(id, stop ? AbortSignal.any([stop, signal]) : signal)
  } else {
    if (store.job(id)?.state === 'review') queue.recompute(id)
    const until = Date.now() + (context.waitMs ?? WAIT_MS)
    while (store.job(id)?.state === 'refreshing' && Date.now() < until)
      await delay(context.pollMs ?? POLL_MS, undefined, { signal })
  }
  signal.throwIfAborted()
  const job = store.job(id)
  if (!job) throw new Error(READ_NOT_WAITING)
  if (job.state === 'failed')
    throw new Error(`Brain could not refresh this read: ${job.error ?? 'unknown error'}`)
  if (job.state === 'empty') throw new Error(READ_NOW_EMPTY)
  if (job.state !== 'review' && job.state !== 'refreshing') throw new Error(READ_NOT_WAITING)
  if (job.state === 'review' && !reviewStale(store, id)) return null
  // The lane may have become unreadable while it refreshed.
  if (job.state === 'review') {
    const late = await check()
    if (late) return late
  }
  throw new Error(READ_STILL_REFRESHING)
}
