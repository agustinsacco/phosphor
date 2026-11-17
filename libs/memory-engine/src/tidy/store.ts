import { tidyRunState, saveTidyRunState } from './run-state'
import { emptyBrainTidyPage, emptyBrainTidySummary } from '@phosphor/shared/brain-tidy'
import type { Context } from '../database'
import { revision } from '../prefs'
import type { BrainTidyStore } from './types'

const notReady = (): never => {
  throw new Error('Brain Tidy is not ready.')
}
export function tidyStore(ctx: Context): BrainTidyStore {
  return {
    tidyRunState: () => tidyRunState(ctx),
    saveTidyRunState: (value) => saveTidyRunState(ctx, value),
    tidySummary: emptyBrainTidySummary,
    tidy: () => emptyBrainTidyPage(revision(ctx)),
    tidySuggestion: notReady,
    tidyApply: notReady,
    tidyDismiss: notReady,
    tidyChanges: () => ({ items: [], revision: revision(ctx) }),
    tidyUndo: notReady,
    sweep: notReady,
    pendingPairs: () => [],
    recordVerdicts: notReady,
    flag: notReady,
  }
}
