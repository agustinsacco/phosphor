import { afterOperation, afterUndo } from './hooks'
import type { Context } from '../database'
import type { BrainTidyStore } from './types'
import { readRun, writeRun } from './run-state'
import { summary, dismiss, flag } from './suggestions'
import { page, detail, changes } from './reads'
import { apply } from './apply'
import { undoOperation } from './operations'
import { pendingPairs, recordVerdicts } from './verdicts'
import { sweep } from './sweep'
import { takeMaintenance } from './maintenance'
import { describeEntity, removeName, splitEntity } from './entity-edits'

export function tidyStore(ctx: Context): BrainTidyStore {
  return {
    readRun: () => readRun(ctx),
    writeRun: (value) => writeRun(ctx, value),
    tidySummary: () => summary(ctx),
    tidy: (kind, cursor, limit) => page(ctx, kind, cursor, limit),
    tidySuggestion: (id) => detail(ctx, id),
    tidyApply: (id, action, revision) => {
      const operation = apply(ctx, id, action, revision)
      afterOperation(ctx, operation)
      return operation
    },
    tidyDismiss: (id, revision) => dismiss(ctx, id, revision),
    tidyChanges: (limit) => changes(ctx, limit),
    tidyUndo: (id, revision) => {
      afterUndo(ctx, undoOperation(ctx, id, revision))
    },
    describe: (id, description, revision) => describeEntity(ctx, id, description, revision),
    removeName: (id, name, revision) => removeName(ctx, id, name, revision),
    split: (id, memoryIds, target, revision) => {
      const operation = splitEntity(ctx, id, memoryIds, target, revision)
      afterOperation(ctx, operation)
      return operation
    },
    sweep: (input) => sweep(ctx, input),
    takeTidyMaintenance: () => takeMaintenance(ctx),
    pendingPairs: (limit) => pendingPairs(ctx, limit),
    recordVerdicts: (judgements) => recordVerdicts(ctx, judgements),
    flag: (input) => flag(ctx, input),
  }
}
