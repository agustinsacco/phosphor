import type {
  BrainTidyChanges,
  BrainTidyFlag,
  BrainTidyFlagResult,
  BrainTidySummary,
  BrainTidySweep,
  BrainTidyTouched,
} from '@phosphor/shared/brain-tidy'
import type { BrainEntityKind } from '@phosphor/shared/brain'

export interface BrainTidyStore {
  tidySummary(): BrainTidySummary
  tidyChanges(limit: number): BrainTidyChanges
  tidyUndo(operationId: string, revision: number): void
  /** Entity edits journal like merges: each returns its operation id and refuses a stale revision. */
  describe(entityId: string, description: string, revision: number): string
  /** Removes one alias, never the label. */
  removeName(entityId: string, name: string, revision: number): string
  /** Moves 1–200 memories, with their mentions and links, to a new record. */
  split(
    entityId: string,
    memoryIds: string[],
    target: { label: string; kind: BrainEntityKind },
    revision: number,
  ): string
  /** One bounded chunk per call. 'all' resumes the saved cursor; a finished pass starts anew. */
  sweep(touched: BrainTidyTouched | 'all'): BrainTidySweep
  /**
   * Touched memories a merge, undo or approval left unswept (beyond the first 128), once each.
   * The caller sweeps them in bounded batches; they have no fingerprints until then.
   */
  takeTidyMaintenance(): string[]
  /** One open flag per memory; at most five open flags per lane. Returns the suggestion id. */
  flag(input: BrainTidyFlag): BrainTidyFlagResult
}
