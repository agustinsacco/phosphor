import { afterOperation, afterUndo } from './hooks'
import type { Context } from '../database'
import type { BrainTidyStore } from './types'
import { summary, flag } from './suggestions'
import { changes } from './reads'
import { undoOperation } from './operations'
import { sweep } from './sweep'
import { takeMaintenance } from './maintenance'
import { describeEntity, removeName, splitEntity } from './entity-edits'

export function tidyStore(ctx: Context): BrainTidyStore {
  return {
    tidySummary: () => summary(ctx),
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
    flag: (input) => flag(ctx, input),
  }
}
