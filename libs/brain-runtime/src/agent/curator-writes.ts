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
import { readDecision } from './read-decision'
import { plainRefusal } from './refusal'
import { freshReview, reviewStale } from './review-refresh'
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

interface Writer {
  /** The journal note: the Defrag run Brain Agent is answering, if any, and the scrubbed reason. */
  note(reason: string): { runId: string | null; reason: string }
  /** Applies one change, maps engine refusals to statuses, then refreshes search and shows it. */
  write(change: () => string | null, message: string): Promise<BrainAgentWrite>
}

function writer(context: CuratorContext): Writer {
  const { search, queue } = context
  return {
    note: (reason) => ({
      runId: context.defrag.turnRun()?.runId ?? null,
      reason: scrubExcerpt(reason),
    }),
    async write(change, message) {
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
    },
  }
}

/** Approval needs the current review of a lane Brain may read; null when it may go ahead. */
async function approvalRefusal(
  context: CuratorContext,
  jobId: string,
  revision: number,
  signal: AbortSignal,
): Promise<BrainAgentWrite | null> {
  const { store } = context
  let refusal: string | null
  try {
    waitingRead(store, jobId)
    refusal = await freshReview(refreshContext(context), jobId, signal)
  } catch (error) {
    signal.throwIfAborted()
    return refused(plainRefusal(error))
  }
  // A fresh read is refused with the rule itself; a stale one also says it cannot refresh.
  if (refusal)
    return refused(
      refusal === DELETED_LANE_REFRESH_REFUSAL ||
        refusal === BRAIN_OWN_LANE_REFUSAL ||
        !reviewStale(store, jobId)
        ? refusal
        : NEVER_READ_REFRESH_REFUSAL,
    )
  const never = brainNeverReadReason(store.snapshot().prefs.neverRead, store.job(jobId)!)
  if (never) return refused(never)
  if (store.storedProposal(jobId)?.computedRevision !== revision)
    return { status: 'changed', message: READ_CHANGED, operationId: null }
  return null
}

function decideRead(context: CuratorContext, { note, write }: Writer): CuratorApi['decideRead'] {
  const { store, queue } = context
  return async ({ jobId, revision, approve, reason, ...choices }, signal) => {
    if (!context.enabled()) return refused(BRAIN_OFF)
    if (!approve) {
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
    const refusal = await approvalRefusal(context, jobId, revision, signal)
    if (refusal) return refusal
    const built = readDecision(store.proposal(jobId), choices)
    if ('problem' in built) return refused(built.problem)
    return write(
      () => store.decideRead(jobId, built.decision, revision, note(reason)).operationId,
      'Approved. Brain changed, so other reads may refresh when you open them.',
    )
  }
}

/** Brain Agent's changes: each journaled with its run and its one-sentence reason, then shown. */
export function curatorWrites(
  context: CuratorContext,
): Pick<CuratorApi, 'decideRead' | 'resolve' | 'edit' | 'correct' | 'erase' | 'undo'> {
  const { store, options } = context
  const tools = writer(context)
  const { note, write } = tools
  return {
    decideRead: decideRead(context, tools),
    resolve: async ({ suggestionId, action, reason }) =>
      write(() => store.resolve(suggestionId, action, note(reason)), RESOLVED[action.kind]),
    edit: async ({ edit, reason }) =>
      write(() => store.agentEdit(edit, note(reason)), EDITED[edit.kind]),
    correct: async ({ memoryId, summary, source, quote, reason }, signal) => {
      const text = scrubExcerpt(summary)
      // No local model saves it without a vector; a cancelled call saves nothing.
      const vector = await options.embeddings
        .embed([text], 'document', signal)
        .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
        .catch(() => null)
      signal.throwIfAborted()
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
