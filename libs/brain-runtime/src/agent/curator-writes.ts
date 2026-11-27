import {
  BRAIN_ERASE_LIMIT_REFUSAL,
  BRAIN_RELATE_LIMIT_REFUSAL,
  type BrainAgentEdit,
  type BrainAgentWrite,
  type BrainResolve,
} from '@phosphor/shared/brain-agent'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { plainRefusal } from './refusal'
import { BRAIN_OFF, type CuratorApi, type CuratorContext } from './curator-context'
import { BRAIN_TURN_REFUSAL, curatorTurn, type CuratorTurn } from './curator-turn'

const RESOLVED: Record<BrainResolve['action']['kind'], string> = {
  merge: 'Merged.',
  group: 'Grouped the records.',
  fold: 'Folded the repeat into the memory you kept.',
  dispute: 'Kept both as disputed.',
  replace: 'Replaced the older memory.',
  keep: 'Kept both as they are.',
  unname: 'Removed the shared name.',
}
const EDITED: Record<BrainAgentEdit['kind'], string> = {
  merge: 'Merged.',
  relation: 'Updated the relationship.',
  importance: 'Updated the importance.',
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
  /** The journal note: the Defrag run of the asking turn, if any, and the scrubbed reason. */
  note(turn: CuratorTurn, reason: string): { runId: string | null; reason: string }
  /**
   * Applies one change for `turn`, rechecking its authority right before the change; maps
   * engine refusals to statuses, then refreshes search and shows it.
   */
  write(
    turn: CuratorTurn | null,
    change: (turn: CuratorTurn) => string | null,
    message: string,
  ): Promise<BrainAgentWrite>
}

function writer(context: CuratorContext): Writer {
  const { search, queue } = context
  return {
    note: (turn, reason) => ({ runId: turn.runId(), reason: scrubExcerpt(reason) }),
    async write(turn, change, message) {
      if (!context.enabled()) return refused(BRAIN_OFF)
      if (!turn?.admit()) return refused(BRAIN_TURN_REFUSAL)
      let operationId: string | null
      try {
        operationId = change(turn)
      } catch (error) {
        const text = error instanceof Error ? error.message : ''
        if (text === BRAIN_ERASE_LIMIT_REFUSAL || text === BRAIN_RELATE_LIMIT_REFUSAL)
          return { status: 'limit', message: text, operationId: null }
        return refused(plainRefusal(error))
      }
      await search.refresh()
      context.changed()
      queue.kick()
      return { status: 'done', message, operationId }
    },
  }
}

/** Brain Agent's changes: each journaled with its run and its one-sentence reason, then shown. */
export function curatorWrites(
  context: CuratorContext,
): Pick<CuratorApi, 'relate' | 'resolve' | 'edit' | 'correct' | 'erase' | 'undo'> {
  const { store, options } = context
  const tools = writer(context)
  const { note, write } = tools
  const turn = () => curatorTurn(context)
  return {
    relate: async ({ reason, ...link }) =>
      write(turn(), (t) => store.relate(link, note(t, reason)), 'Stated the relationship.'),
    resolve: async ({ suggestionId, action, reason }) =>
      write(
        turn(),
        (t) => store.resolve(suggestionId, action, note(t, reason)),
        RESOLVED[action.kind],
      ),
    edit: async ({ edit, reason }) =>
      write(turn(), (t) => store.agentEdit(edit, note(t, reason)), EDITED[edit.kind]),
    correct: async ({ memoryId, summary, source, quote, links, ends, reason }, signal) => {
      // The turn that asked, captured before the model runs: the write rechecks it after.
      const asking = turn()
      if (!asking) return refused(BRAIN_TURN_REFUSAL)
      const text = scrubExcerpt(summary)
      // No local model saves it without a vector; a cancelled call saves nothing.
      const vector = await options.embeddings
        .embed([text], 'document', signal)
        .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
        .catch(() => null)
      signal.throwIfAborted()
      let report = ''
      const result = await write(
        asking,
        (t) => {
          const fixed = store.correct(
            {
              memoryId,
              links,
              ends,
              summary: text,
              source: scrubExcerpt(source),
              quote: scrubExcerpt(quote),
            },
            vector,
            note(t, reason),
          )
          const list = (links: typeof fixed.carried) =>
            links.length
              ? links
                  .map((l) => l.id)
                  .join(', ')
                  .slice(0, 160)
              : 'none'
          report = `Corrected. Current links: ${list(fixed.carried)}. Ended: ${list(fixed.ended)}. Undo restores the old memory.`
          return fixed.operationId
        },
        'Corrected.',
      )
      return result.status === 'done' ? { ...result, message: report } : result
    },
    erase: async ({ memoryId, reason }) => {
      const result = await write(
        turn(),
        (t) => store.erase(memoryId, note(t, reason)),
        'Erased. This is final: only your reason is kept.',
      )
      // An erasure cannot be undone, so it offers no operation.
      return { ...result, operationId: null }
    },
    undo: async ({ operationId, reason }) =>
      write(
        turn(),
        (t) => {
          store.agentUndo(operationId, note(t, reason))
          return null
        },
        'Undone.',
      ),
  }
}
