import type { BrainAgentEdit } from '@phosphor/shared/brain-agent'
import { all, type Context } from '../database'
import { revision } from '../prefs'
import { afterChange, afterOperation, afterUndo } from '../tidy/hooks'
import { apply } from '../tidy/apply'
import { detail } from '../tidy/reads'
import { undo } from '../tidy/journal'
import { mergeEntities } from '../tidy/operations'
import { describeEntity, removeName, splitEntity } from '../tidy/entity-edits'
import { editRelation, relate, setImportance } from './relate'
import { correct } from './correct'
import { erase } from './erase'
import { cleanNote } from './notes'
import { waitingCounts, waitingSignature, waitingSuggestions } from './waiting'
import * as runs from './runs'
import type { BrainAgentStore, BrainChangeNote } from './types'

function edit(ctx: Context, value: BrainAgentEdit, rawNote: BrainChangeNote): string {
  const note = cleanNote(rawNote),
    expected = revision(ctx)
  switch (value.kind) {
    case 'merge':
      return mergeEntities(ctx, value.sourceId, value.targetId, expected, undefined, note)
    case 'describe':
      return describeEntity(ctx, value.entityId, value.description, expected, note)
    case 'removeName':
      return removeName(ctx, value.entityId, value.name, expected, note)
    case 'split':
      return splitEntity(
        ctx,
        value.entityId,
        value.memoryIds,
        { label: value.label, kind: value.entityKind },
        expected,
        note,
      )
    case 'relation':
      return editRelation(ctx, value, note)
    case 'importance':
      return setImportance(ctx, value, note)
    default:
      throw new Error('Unknown Brain Agent edit.')
  }
}
function afterMemoryChange(ctx: Context, operation: string): void {
  afterChange(ctx, {
    entityIds: [],
    memoryIds: all<{ memory_id: string }>(
      ctx,
      'SELECT m.memory_id FROM tidy_operation_memories m JOIN memories r ON r.id=m.memory_id WHERE operation_id=?',
      operation,
    ).map((r) => r.memory_id),
  })
}
export function agentStore(ctx: Context): BrainAgentStore {
  return {
    waitingCounts: () => waitingCounts(ctx),
    waitingSuggestions: (limit, possibleRepeats) => waitingSuggestions(ctx, limit, possibleRepeats),
    agentSuggestion: (id) => detail(ctx, id, true),
    waitingSignature: () => waitingSignature(ctx),
    relate: (value, note) => {
      const operation = relate(ctx, value, cleanNote(note))
      afterMemoryChange(ctx, operation)
      return operation
    },
    resolve: (id, action, note) => {
      if (action.kind === 'forget') throw new Error('Use brain_erase to erase a memory.')
      const operation = apply(ctx, id, action, revision(ctx), cleanNote(note))!
      if (action.kind === 'group') afterMemoryChange(ctx, operation)
      else afterOperation(ctx, operation)
      return operation
    },
    agentEdit: (value, note) => {
      const operation = edit(ctx, value, note)
      if (value.kind === 'relation' || value.kind === 'importance')
        afterMemoryChange(ctx, operation)
      else afterOperation(ctx, operation)
      return operation
    },
    correct: (value, vector, note) => {
      const result = correct(ctx, value, vector, note)
      afterMemoryChange(ctx, result.operationId)
      return result
    },
    erase: (id, note) => erase(ctx, id, note),
    agentUndo: (id, note) => afterUndo(ctx, undo(ctx, id, revision(ctx), note)),
    createRun: (automatic) => runs.createRun(ctx, automatic ?? false),
    updateRun: (id, patch) => runs.updateRun(ctx, id, patch),
    latestRun: () => runs.latestRun(ctx),
    interruptRuns: (message) => runs.interruptRuns(ctx, message),
    undoRun: (id) => runs.undoRun(ctx, id),
  }
}
