import type {
  BrainAgentEdit,
  BrainAgentRun,
  BrainLinkInput,
  BrainRelate,
  BrainWaitingCounts,
  BrainWaitingItem,
} from '@phosphor/shared/brain-agent'
import type { BrainLink } from '@phosphor/shared/brain-links'
import type { BrainTidyAction, BrainTidySuggestionDetail } from '@phosphor/shared/brain-tidy'

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
  /** Links the corrected sentence states, stored on the corrected memory before the carry. */
  links?: BrainLinkInput[]
  /** Relation ids of the old memory the correction ends rather than carries. */
  ends?: string[]
}
/** What a correction did to the old memory's links. */
export interface CorrectResult {
  operationId: string
  /** Links now on the corrected memory, carried from the old one or stated by the correction. */
  carried: BrainLink[]
  /** The old memory's links the correction ended, by `ends` or by contradiction. */
  ended: BrainLink[]
}
/** A link Brain Agent states; its reason travels in the change note. */
export type RelateInput = Omit<BrainRelate, 'reason'>
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
  /** The header count: open suggestions by kind. */
  waitingCounts(): BrainWaitingCounts
  /** `${count}:${newest createdAt}` over the open counted suggestions, so an automatic run can
   * tell whether anything new waits since the last one ended. */
  waitingSignature(): string
  /**
   * Open suggestions oldest first: same entity, groups, unlinked pairs, same memory, conflicts,
   * flags, then at most `possibleRepeats` unchecked pairs (`possible_repeat`, never counted).
   */
  waitingSuggestions(
    limit: number,
    possibleRepeats: number,
  ): { items: BrainWaitingItem[]; more: number }
  /** One suggestion with its allowed actions, unchecked pairs included. */
  agentSuggestion(id: string): BrainTidySuggestionDetail | null
  /**
   * Merge, fold, dispute, replace, unname, group or keep. `keep` is journaled; undo reopens it.
   * `group` states the group suggestion's `part_of` links, creating its parent if needed.
   */
  resolve(suggestionId: string, action: BrainTidyAction, note: BrainChangeNote): string
  /**
   * States a link on the newest cited memory naming both ends, as Brain Agent. Settles
   * `suggestionId` when given. Refused past BRAIN_RELATE_PER_RUN in a run.
   */
  relate(input: RelateInput, note: BrainChangeNote): string
  /** Merge, describe, split, removeName, a relation's wording and dates, or a memory's importance. */
  agentEdit(edit: BrainAgentEdit, note: BrainChangeNote): string
  /**
   * Replaces the memory with a corrected one citing the quote; `vector` embeds `summary`. The old
   * memory's links carry over unless `ends` names them or a corrected link contradicts them.
   */
  correct(input: BrainCorrection, vector: Float32Array | null, note: BrainChangeNote): CorrectResult
  /**
   * Final: forgets the memory and journals only the reason. Refused, changing nothing, past
   * BRAIN_ERASE_LIMIT Brain Agent erasures in the last hour.
   */
  erase(memoryId: string, note: BrainChangeNote): string
  /** Undoes any journaled change and records who undid it and why. */
  agentUndo(operationId: string, note: BrainChangeNote): void
  /** A queued run; `automatic` marks one the automatic check started. */
  createRun(automatic?: boolean): BrainAgentRun
  updateRun(id: string, patch: BrainRunPatch): BrainAgentRun
  latestRun(): BrainAgentRun | null
  /** At startup: a queued or running run ends as failed with `message`. */
  interruptRuns(message: string): void
  /** Undoes every change of the run that can still be undone, newest first. Erasures stay. */
  undoRun(runId: string): { undone: number; kept: number }
}
