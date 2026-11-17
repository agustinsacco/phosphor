import type {
  BrainTidyAction,
  BrainTidyChanges,
  BrainTidyFlag,
  BrainTidyFlagResult,
  BrainTidyJudgement,
  BrainTidyKind,
  BrainTidyPage,
  BrainTidyRun,
  BrainTidyPair,
  BrainTidySuggestionDetail,
  BrainTidySummary,
  BrainTidySweep,
  BrainTidyTouched,
} from '@phosphor/shared/brain-tidy'

export interface BrainTidyStore {
  readRun(): BrainTidyRun | null
  writeRun(value: BrainTidyRun): void
  tidySummary(): BrainTidySummary
  tidy(kind: BrainTidyKind | null, cursor: string | null, limit: number): BrainTidyPage
  tidySuggestion(id: string): BrainTidySuggestionDetail | null
  tidyApply(id: string, action: BrainTidyAction, revision: number): string | null
  tidyDismiss(id: string, revision: number): void
  tidyChanges(limit: number): BrainTidyChanges
  tidyUndo(operationId: string, revision: number): void
  /** One bounded chunk per call. 'all' resumes the saved cursor; a finished pass starts anew. */
  sweep(touched: BrainTidyTouched | 'all'): BrainTidySweep
  /** At most 40 unjudged, open, two-subject pairs. */
  pendingPairs(limit: number): BrainTidyPair[]
  recordVerdicts(judgements: BrainTidyJudgement[]): void
  /** One open flag per memory; at most five open flags per lane. Returns the suggestion id. */
  flag(input: BrainTidyFlag): BrainTidyFlagResult
}
