import type {
  BrainAgentEdit,
  BrainAgentRun,
  BrainWaitingCounts,
  BrainWaitingItem,
} from '@phosphor/shared/brain-agent'
import type { BrainReviewDecision } from '@phosphor/shared/brain-review'
import type {
  BrainTidyAction,
  BrainTidySuggestionDetail,
  BrainTidyTouched,
} from '@phosphor/shared/brain-tidy'

/** Brain Agent's mark on a journaled change: the Defrag run it belongs to, and why. */
export interface BrainChangeNote {
  runId: string | null
  /** One sentence, 1–300 characters. An erasure keeps only this, never the memory's text. */
  reason: string
}
export interface BrainCorrection {
  memoryId: string
  summary: string
  /** Where the quote comes from: "Linear KES-12", "Slack #ledger". */
  source: string
  quote: string
}
export type BrainRunPatch = Partial<
  Pick<
    BrainAgentRun,
    'state' | 'total' | 'startedAt' | 'finishedAt' | 'error' | 'sessionPath' | 'rulesChanged'
  >
>

/**
 * What Brain Agent changes, through the same engine calls the Brain page makes. Every write is
 * journaled as Brain Agent with its reason, in one transaction, and returns the operation id that
 * undoes it. None takes a page revision: each checks that its subjects still exist and the action
 * still applies when it runs.
 */
export interface BrainAgentStore {
  /** The header count: reads in review or refreshing, and open suggestions by kind. */
  waitingCounts(): BrainWaitingCounts
  /**
   * Open suggestions oldest first: same entity, same memory, conflicts, flags, then at most
   * `possibleRepeats` unchecked pairs (`possible_repeat`, never counted).
   */
  waitingSuggestions(
    limit: number,
    possibleRepeats: number,
  ): { items: BrainWaitingItem[]; more: number }
  /** One suggestion with its allowed actions, unchecked pairs included. */
  agentSuggestion(id: string): BrainTidySuggestionDetail | null
  /**
   * Approve (`decision`) or reject (null) a read, as `review` does, journaled and undoable: undo
   * puts the read back in review with its proposal. `revision` is the proposal's computed revision.
   */
  decideRead(
    jobId: string,
    decision: BrainReviewDecision | null,
    revision: number,
    note: BrainChangeNote,
  ): { operationId: string; touched: BrainTidyTouched }
  /** Merge, fold, dispute, replace, unname or keep. `keep` is journaled; undo reopens it. */
  resolve(suggestionId: string, action: BrainTidyAction, note: BrainChangeNote): string
  agentEdit(edit: BrainAgentEdit, note: BrainChangeNote): string
  /** Replaces the memory with a corrected one citing the quote; `vector` embeds `summary`. */
  correct(input: BrainCorrection, vector: Float32Array | null, note: BrainChangeNote): string
  /**
   * Final: forgets the memory and journals only the reason. Refused, changing nothing, past
   * BRAIN_ERASE_LIMIT Brain Agent erasures in the last hour.
   */
  erase(memoryId: string, note: BrainChangeNote): string
  /** Undoes any journaled change and records who undid it and why. */
  agentUndo(operationId: string, note: BrainChangeNote): void
  createRun(): BrainAgentRun
  updateRun(id: string, patch: BrainRunPatch): BrainAgentRun
  latestRun(): BrainAgentRun | null
  /** At startup: a queued or running run ends as failed with `message`. */
  interruptRuns(message: string): void
  /** Undoes every change of the run that can still be undone, newest first. Erasures stay. */
  undoRun(runId: string): { undone: number; kept: number }
}
