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
    sweep: (input) => sweep(ctx, input),
    pendingPairs: (limit) => pendingPairs(ctx, limit),
    recordVerdicts: (judgements) => recordVerdicts(ctx, judgements),
    flag: (input) => flag(ctx, input),
  }
}
