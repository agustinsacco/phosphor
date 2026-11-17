import type { Context } from '../database'
import type { BrainTidyStore } from './types'
import { tidyRunState, saveTidyRunState } from './run-state'
import { summary, dismiss, flag } from './suggestions'
import { page, detail, changes } from './reads'
import { apply } from './apply'
import { undoOperation } from './operations'
import { pendingPairs, recordVerdicts } from './verdicts'
import { sweep } from './sweep'

export function tidyStore(ctx: Context): BrainTidyStore {
  return {
    tidyRunState: () => tidyRunState(ctx),
    saveTidyRunState: (value) => saveTidyRunState(ctx, value),
    tidySummary: () => summary(ctx),
    tidy: (kind, cursor, limit) => page(ctx, kind, cursor, limit),
    tidySuggestion: (id) => detail(ctx, id),
    tidyApply: (id, action, revision) => apply(ctx, id, action, revision),
    tidyDismiss: (id, revision) => dismiss(ctx, id, revision),
    tidyChanges: (limit) => changes(ctx, limit),
    tidyUndo: (id, revision) => {
      undoOperation(ctx, id, revision)
    },
    sweep: (input) => sweep(ctx, input),
    pendingPairs: (limit) => pendingPairs(ctx, limit),
    recordVerdicts: (judgements) => recordVerdicts(ctx, judgements),
    flag: (input) => flag(ctx, input),
  }
}
