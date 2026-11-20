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
  queue: Pick<ExtractionQueue, 'recompute' | 'refreshInline'>
  /** Brain Agent's folder, whose lanes Brain never reads. */
  folder?: string
  /** The running Defrag task's signal, or null outside a run. */
  defragSignal(): AbortSignal | null
  /** Outside a run, how long to wait for the queue's own refresh. */
  waitMs?: number
  pollMs?: number
}

const WAIT_MS = 10 * 60_000
const POLL_MS = 500

function stale(store: BrainStore, id: string): boolean {
  const job = store.job(id)
  const proposal = store.storedProposal(id)
  return (
    !!job &&
    !!proposal &&
    (job.state === 'refreshing' || proposal.computedRevision !== store.knowledgeRevision())
  )
}

/**
 * Brings a waiting read up to date before Brain Agent reads or decides it. Inside a Defrag run
 * the run refreshes it itself (the run holds the worker); outside one the queue refreshes it and
 * this waits, at most ten minutes. Never a second model run. Returns the refusal when the lane
 * cannot be read again (never read, Brain's own lane, deleted): its stale review stays, to reject.
 */
export async function freshReview(
  context: ReviewRefreshContext,
  id: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { store, files, queue } = context
  const check = async (): Promise<string | null> => {
    const job = store.job(id)
    return job ? (await currentReadCheck(store, files, job, context.folder)).refusal : null
  }
  if (!stale(store, id)) return null
  const refusal = await check()
  if (refusal) return refusal
  const task = context.defragSignal()
  if (task) await queue.refreshInline(id, AbortSignal.any([task, signal]))
  else {
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
  if (job.state === 'review' && !stale(store, id)) return null
  // The lane may have become unreadable while it refreshed.
  if (job.state === 'review') {
    const late = await check()
    if (late) return late
  }
  throw new Error(READ_STILL_REFRESHING)
}
