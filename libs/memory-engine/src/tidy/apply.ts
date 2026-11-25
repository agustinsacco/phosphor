import type { JournalNote } from '../agent/notes'
import { checkBrainTidyAction, type BrainTidyAction } from '@phosphor/shared/brain-tidy'
import { one, run, transaction, type Context } from '../database'
import { bumpRevision, bumpKnowledgeRevision } from '../prefs'
import { journal } from './journal'
import { changeMemories, mergeChange } from './operations'
import { actionRefusal } from './action-guards'
import { openSuggestion, type SuggestionRow } from './suggestions'
import { removableNames, removeNameChange } from './entity-edits'
import { fold } from '../text'
import { groupChange } from '../agent/group'

/** Brain Agent settles a suggestion; every action is journaled with its note. */
export function apply(ctx: Context, id: string, raw: BrainTidyAction, note: JournalNote): string {
  const action = checkBrainTidyAction(raw)
  return transaction(ctx, () => {
    const row = openSuggestion(ctx, id)
    const refusal = actionRefusal(ctx, row, action.kind)
    if (refusal) throw new Error(refusal)
    const operation = applyAction(ctx, row, action, note)
    run(
      ctx,
      'UPDATE tidy_suggestions SET state=?,updated_at=? WHERE id=?',
      // Removing the shared name answers the pair: these are not the same.
      action.kind === 'keep' || action.kind === 'unname' ? 'dismissed' : 'applied',
      ctx.now(),
      id,
    )
    return operation
  })
}
function applyAction(
  ctx: Context,
  row: SuggestionRow,
  action: BrainTidyAction,
  note: JournalNote,
): string {
  const ids = [row.first_id, row.second_id],
    id = row.id
  if (action.kind === 'merge' && ids.includes(action.survivorId))
    return mergeChange(
      ctx,
      ids.find((s) => s !== action.survivorId)!,
      action.survivorId,
      id,
      note,
    )
  if (action.kind === 'fold' && ids.includes(action.survivorId))
    return changeMemories(
      ctx,
      ids.find((s) => s !== action.survivorId)!,
      action.survivorId,
      'fold',
      { suggestionId: id, note },
    )
  if (action.kind === 'dispute')
    return changeMemories(ctx, row.first_id, row.second_id!, 'dispute', { suggestionId: id, note })
  if (action.kind === 'replace' && ids.includes(action.newerId))
    return changeMemories(
      ctx,
      action.newerId,
      ids.find((s) => s !== action.newerId)!,
      'replace',
      { suggestionId: id, note },
    )
  if (action.kind === 'unname' && ids.includes(action.entityId)) {
    if (
      !removableNames(ctx, row.first_id, row.second_id!).some(
        (name) => name.entityId === action.entityId && name.folded === fold(action.name),
      )
    )
      throw new Error('That is not a name these records share.')
    const operation = removeNameChange(ctx, action.entityId, action.name, id, note)
    bumpKnowledgeRevision(ctx)
    return operation
  }
  if (action.kind === 'group') return groupChange(ctx, row, note)
  if (action.kind === 'keep') return keepChange(ctx, row, note)
  throw new Error('This action does not apply to this Tidy suggestion.')
}
function keepChange(ctx: Context, row: SuggestionRow, note: JournalNote): string {
  const operation = journal(
    ctx,
    {
      kind: 'keep',
      note,
      suggestionId: row.id,
      subjects: {
        type: row.subject_type,
        first: row.first_id,
        second: row.second_id ?? row.first_id,
      },
      selection: { entities: [], memories: [] },
      summary: keepSummary(ctx, row),
    },
    () => undefined,
  )
  bumpRevision(ctx)
  return operation
}
function keepSummary(ctx: Context, row: SuggestionRow): string {
  if (row.kind === 'flagged') return 'Kept the flagged memory'
  if (row.kind === 'group') return 'Kept these apart from the group a read suggested'
  if (row.kind === 'unlinked') {
    const label = (id: string) =>
      one<{ label: string }>(ctx, 'SELECT label FROM entities WHERE id=?', id)!.label
    return `No lasting link: ${label(row.first_id)} and ${label(row.second_id!)}`
  }
  if (row.subject_type === 'memory') return 'Kept both memories'
  const label = (id: string) =>
    one<{ label: string }>(ctx, 'SELECT label FROM entities WHERE id=?', id)!.label
  return `Not the same: ${label(row.first_id)} and ${label(row.second_id!)}`
}
