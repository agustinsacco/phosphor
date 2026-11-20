import { brainNeverReadReason } from '@phosphor/shared/brain'
import {
  BRAIN_ERASE_LIMIT_REFUSAL,
  type BrainAgentEdit,
  type BrainAgentWrite,
  type BrainResolve,
} from '@phosphor/shared/brain-agent'
import { BRAIN_REVIEW_CHANGED } from '@phosphor/shared/brain-review'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { DELETED_LANE_REFRESH_REFUSAL, NEVER_READ_REFRESH_REFUSAL } from '../lane-read-rules'
import { BRAIN_OWN_LANE_REFUSAL } from './own-lane'
import { plainRefusal } from './refusal'
import { freshReview } from './review-refresh'
import {
  BRAIN_OFF,
  refreshContext,
  waitingRead,
  type CuratorApi,
  type CuratorContext,
} from './curator-context'

export const READ_CHANGED =
  'Brain refreshed this read since you read it. Read it again with brain_read_review, then decide.'

const RESOLVED: Record<BrainResolve['action']['kind'], string> = {
  merge: 'Merged.',
  fold: 'Folded the repeat into the memory you kept.',
  dispute: 'Kept both as disputed.',
  replace: 'Replaced the older memory.',
  keep: 'Kept both as they are.',
  unname: 'Removed the shared name.',
}
const EDITED: Record<BrainAgentEdit['kind'], string> = {
  merge: 'Merged.',
  describe: 'Saved the description.',
  split: 'Split the memories off into their own record.',
  removeName: 'Removed the name.',
}
const refused = (message: string): BrainAgentWrite => ({
  status: 'refused',
  message,
  operationId: null,
})

/** Brain Agent's changes: each journaled with its run and its one-sentence reason, then shown. */
export function curatorWrites(
  context: CuratorContext,
): Pick<CuratorApi, 'decideRead' | 'resolve' | 'edit' | 'correct' | 'erase' | 'undo'> {
  const { store, search, queue, options } = context
  const note = (reason: string) => ({
    runId: context.defrag.current()?.runId ?? null,
    reason: scrubExcerpt(reason),
  })
  async function write(change: () => string | null, message: string): Promise<BrainAgentWrite> {
    if (!context.enabled()) return refused(BRAIN_OFF)
    let operationId: string | null
    try {
      operationId = change()
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      if (text === BRAIN_ERASE_LIMIT_REFUSAL)
        return { status: 'limit', message: text, operationId: null }
      if (text === BRAIN_REVIEW_CHANGED)
        return { status: 'changed', message: READ_CHANGED, operationId: null }
      return refused(plainRefusal(error))
    }
    await search.refresh()
    context.changed()
    queue.kick()
    return { status: 'done', message, operationId }
  }

  /** Approval needs the current review of a lane Brain may read; null when it may go ahead. */
  async function approvalRefusal(
    jobId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<BrainAgentWrite | null> {
    let refusal: string | null
    try {
      waitingRead(store, jobId)
      refusal = await freshReview(refreshContext(context), jobId, signal)
    } catch (error) {
      signal.throwIfAborted()
      return refused(plainRefusal(error))
    }
    if (refusal)
      return refused(
        refusal === DELETED_LANE_REFRESH_REFUSAL || refusal === BRAIN_OWN_LANE_REFUSAL
          ? refusal
          : NEVER_READ_REFRESH_REFUSAL,
      )
    const never = brainNeverReadReason(store.snapshot().prefs.neverRead, store.job(jobId)!)
    if (never) return refused(never)
    if (store.storedProposal(jobId)?.computedRevision !== revision)
      return { status: 'changed', message: READ_CHANGED, operationId: null }
    return null
  }

  return {
    decideRead: async ({ jobId, revision, decision, reason }, signal) => {
      if (!context.enabled()) return refused(BRAIN_OFF)
      if (decision === null) {
        // A rejection needs no refresh and holds whatever the revision.
        try {
          waitingRead(store, jobId)
        } catch (error) {
          return refused(plainRefusal(error))
        }
        queue.abortRefresh(jobId)
        return write(
          () => store.decideRead(jobId, null, revision, note(reason)).operationId,
          'Rejected. Undo puts the read back to waiting.',
        )
      }
      const refusal = await approvalRefusal(jobId, revision, signal)
      if (refusal) return refusal
      return write(
        () => store.decideRead(jobId, decision, revision, note(reason)).operationId,
        'Approved. Brain changed, so other reads may refresh when you open them.',
      )
    },
    resolve: async ({ suggestionId, action, reason }) =>
      write(() => store.resolve(suggestionId, action, note(reason)), RESOLVED[action.kind]),
    edit: async ({ edit, reason }) =>
      write(() => store.agentEdit(edit, note(reason)), EDITED[edit.kind]),
    correct: async ({ memoryId, summary, source, quote, reason }) => {
      const text = scrubExcerpt(summary)
      const vector = await options.embeddings
        .embed([text], 'document')
        .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
        .catch(() => null)
      return write(
        () =>
          store.correct(
            { memoryId, summary: text, source: scrubExcerpt(source), quote: scrubExcerpt(quote) },
            vector,
            note(reason),
          ),
        'Corrected. The old memory is replaced; undo restores it.',
      )
    },
    erase: async ({ memoryId, reason }) => {
      const result = await write(
        () => store.erase(memoryId, note(reason)),
        'Erased. This is final: only your reason is kept.',
      )
      // An erasure cannot be undone, so it offers no operation.
      return { ...result, operationId: null }
    },
    undo: async ({ operationId, reason }) =>
      write(() => {
        store.agentUndo(operationId, note(reason))
        return null
      }, 'Undone.'),
  }
}
