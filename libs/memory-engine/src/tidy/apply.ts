import { checkBrainTidyAction, type BrainTidyAction } from '@phosphor/shared/brain-tidy'
import { run, transaction, type Context } from '../database'
import { removeMemory } from '../merge'
import { pruneExtractions } from '../extractions'
import { bumpRevision } from '../prefs'
import { checkRevision } from './journal'
import { changeMemories, mergeChange } from './operations'
import { actionRefusal } from './action-guards'
import { openSuggestion } from './suggestions'
import { removableNames, removeNameChange } from './entity-edits'
import { fold } from '../text'

export function apply(
  ctx: Context,
  id: string,
  raw: BrainTidyAction,
  expected: number,
): string | null {
  const action = checkBrainTidyAction(raw)
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    const row = openSuggestion(ctx, id)
    const refusal = actionRefusal(ctx, row, action.kind)
    if (refusal) throw new Error(refusal)
    const ids = [row.first_id, row.second_id]
    let operation: string | null = null
    if (action.kind === 'merge' && ids.includes(action.survivorId)) {
      operation = mergeChange(
        ctx,
        ids.find((s) => s !== action.survivorId)!,
        action.survivorId,
        id,
      )
    } else if (action.kind === 'fold' && ids.includes(action.survivorId)) {
      operation = changeMemories(
        ctx,
        ids.find((s) => s !== action.survivorId)!,
        action.survivorId,
        'fold',
        { suggestionId: id },
      )
    } else if (action.kind === 'dispute') {
      operation = changeMemories(ctx, row.first_id, row.second_id!, 'dispute', { suggestionId: id })
    } else if (action.kind === 'replace' && ids.includes(action.newerId)) {
      operation = changeMemories(
        ctx,
        action.newerId,
        ids.find((s) => s !== action.newerId)!,
        'replace',
        { suggestionId: id },
      )
    } else if (action.kind === 'unname' && ids.includes(action.entityId)) {
      if (
        !removableNames(ctx, row.first_id, row.second_id!).some(
          (name) => name.entityId === action.entityId && name.folded === fold(action.name),
        )
      )
        throw new Error('That is not a name these records share.')
      operation = removeNameChange(ctx, action.entityId, action.name, id)
      bumpRevision(ctx)
    } else if (action.kind === 'forget' || action.kind === 'keep') {
      if (action.kind === 'forget') {
        removeMemory(ctx, row.first_id)
        pruneExtractions(ctx)
      }
      bumpRevision(ctx)
    } else throw new Error('This action does not apply to this Tidy suggestion.')
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
