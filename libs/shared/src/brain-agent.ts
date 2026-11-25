/**
 * Brain Agent: the agent of the Brain lane, an ordinary lane in Brain's own folder. Defrag, or
 * the automatic check once reads settle, sends it what is waiting, and it decides each item with
 * the curator tools below. Every surface names it Brain Agent, never its model.
 */
import type { BrainEntityKind, BrainFlagResponse, BrainStatus } from './brain'
import type { BrainEntityView, BrainMemoryDetail } from './brain-explore'
import type { BrainPredicate } from './brain-links'
import type { BrainQuery, BrainSearchResult } from './brain-recall'
import type {
  BrainTidyAction,
  BrainTidyFlag,
  BrainTidyProblem,
  BrainTidySuggestionDetail,
} from './brain-tidy'

export const BRAIN_AGENT_NAME = 'Brain Agent'
/** Brain Agent erasures are final, so at most this many land in any rolling hour. */
export const BRAIN_ERASE_LIMIT = 25
/**
 * The engine's refusal past the erase cap. Errors cross the memory worker as messages, so the
 * runtime recognises this exact text and answers `limit`.
 */
export const BRAIN_ERASE_LIMIT_REFUSAL = `Brain Agent can erase at most ${BRAIN_ERASE_LIMIT} memories an hour. Try again later; nothing changed.`
/** Every Brain Agent change carries a one-sentence reason of 1 to this many characters. */
export const BRAIN_REASON_MAX = 300
/** Defrag hands Brain Agent at most this many unchecked pairs per run, oldest first. */
export const BRAIN_POSSIBLE_REPEATS_PER_RUN = 40
/** Brain Agent states at most this many links in one run. */
export const BRAIN_RELATE_PER_RUN = 60
/** At most this many automatic Brain Agent runs start in any rolling 24 hours. */
export const BRAIN_AUTO_RUNS_PER_DAY = 6
/** The engine's refusal past the relate cap, matched by message as the erase refusal is. */
export const BRAIN_RELATE_LIMIT_REFUSAL = `Brain Agent can state at most ${BRAIN_RELATE_PER_RUN} links a run, or 20 an hour outside a run. Try again later; nothing changed.`
/** The engine's refusal when automatic runs reach their daily cap. */
export const BRAIN_AUTO_RUN_LIMIT_REFUSAL = `Brain Agent already checked on its own ${BRAIN_AUTO_RUNS_PER_DAY} times in the last 24 hours. Run Defrag to check now.`

/** What Defrag decides, counted the way the page header shows it. */
export interface BrainWaitingCounts {
  /** Open "same person or thing" suggestions, identity guesses from reads included. */
  entities: number
  /** Open "are these part of one parent?" questions from reads. */
  groups: number
  /** Open pairs named together with no link saying how they relate. */
  unlinked: number
  /** Open "said twice" suggestions. */
  repeats: number
  /** Open disagreements. */
  conflicts: number
  /** Open flags from lanes. */
  flags: number
}

export type BrainAgentRunState = 'queued' | 'running' | 'done' | 'stopped' | 'failed'
/** One Brain Agent run, from Defrag or automatic. The latest stays in status, with Undo run,
 * until the next one starts. */
export interface BrainAgentRun {
  id: string
  state: BrainAgentRunState
  /** Items waiting when the run started (the header count); 0 while queued. */
  total: number
  /** Brain Agent changes in this run so far, erasures included. */
  decided: number
  erased: number
  /** Changes of this run that Undo run can still reverse. */
  undoable: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  /** The Brain lane's transcript once the run reached it, so the page can open the lane. */
  sessionPath: string | null
  /** Brain Agent edited its own rules (AGENTS.md) during the run. */
  rulesChanged: boolean
  /** Started on its own after reads settled, not by Defrag. */
  automatic: boolean
}
export interface BrainAgentStatus {
  waiting: BrainWaitingCounts
  /** The latest run, until the next one starts. */
  run: BrainAgentRun | null
  /** The Brain lane's folder. Brain never reads lanes there. Null where no Brain lane can run. */
  folder: string | null
}
export interface BrainUndoRunResult extends BrainStatus {
  undone: number
  /** Changes left in place: erasures, and changes later edits depend on. */
  kept: number
}

export type BrainWaitingKind =
  | 'same_entity'
  | 'group'
  | 'unlinked'
  | 'same_memory'
  | 'conflict'
  | 'flagged'
  /** An unchecked pair from the local pass. Not counted in the header. */
  | 'possible_repeat'
export interface BrainWaitingSubject {
  type: 'entity' | 'memory'
  id: string
  label: string
}
export type BrainWaitingItem = {
  kind: BrainWaitingKind
  suggestionId: string
  subjects: BrainWaitingSubject[]
  reason: string
  problem: BrainTidyProblem | null
  createdAt: number
}
export interface BrainWaiting {
  counts: BrainWaitingCounts
  items: BrainWaitingItem[]
  /** Items the limit left out. */
  more: number
}
/** Every write names why, in one sentence. */
export interface BrainAgentReason {
  reason: string
}
/** A link as Brain Agent states it. Dates are YYYY-MM-DD. */
export interface BrainLinkInput {
  subjectId: string
  predicate: BrainPredicate
  objectId: string
  /** The wording, read subject to object: 1 to 80 characters. */
  label: string
  since?: string | null
  until?: string | null
}
/** States a link the cited memories show, as Brain Agent. */
export interface BrainRelate extends BrainAgentReason, BrainLinkInput {
  /** 1 to 8 current memories. One must name both ends; the link is stored on the newest such. */
  memoryIds: string[]
  /** An `unlinked` suggestion this settles. */
  suggestionId?: string
}
export interface BrainResolve extends BrainAgentReason {
  suggestionId: string
  /** Erasing goes through `erase`, so the hourly cap holds. */
  action: BrainTidyAction
}
export type BrainAgentEdit =
  | { kind: 'merge'; sourceId: string; targetId: string }
  | { kind: 'describe'; entityId: string; description: string }
  | {
      kind: 'split'
      entityId: string
      memoryIds: string[]
      label: string
      entityKind: BrainEntityKind
    }
  | { kind: 'removeName'; entityId: string; name: string }
  /** A link's wording and dates. A null date clears it; a missing one keeps it. */
  | {
      kind: 'relation'
      relationId: string
      label?: string
      since?: string | null
      until?: string | null
    }
  | { kind: 'importance'; memoryId: string; importance: 'low' | 'normal' | 'high' }
export interface BrainEdit extends BrainAgentReason {
  edit: BrainAgentEdit
}
/** Replaces a memory with a corrected one that cites `quote`, labelled with its `source`. */
export interface BrainCorrect extends BrainAgentReason {
  memoryId: string
  summary: string
  /** Where the quote comes from, such as "Linear KES-12" or "Slack #ledger". */
  source: string
  quote: string
  /** Links the corrected sentence states. */
  links?: BrainLinkInput[]
  /** Relation ids of the old memory that the correction ends. */
  ends?: string[]
}
export interface BrainErase extends BrainAgentReason {
  memoryId: string
}
export interface BrainUndo extends BrainAgentReason {
  operationId: string
}
export interface BrainAgentWrite {
  /**
   * done: saved, and `operationId` can undo it (null for an erasure). refused: nothing changed,
   * `message` says why. limit: the erase or link cap.
   */
  status: 'done' | 'refused' | 'limit'
  message: string
  operationId: string | null
}

/** Bridge methods. Any lane's token calls BRAIN_LANE_METHODS; only the Brain lane's calls the rest. */
export interface BrainAgentMap {
  search: { request: BrainQuery; result: BrainSearchResult }
  flag: { request: BrainTidyFlag; result: BrainFlagResponse }
  waiting: { request: { limit?: number }; result: BrainWaiting }
  suggestion: { request: { suggestionId: string }; result: BrainTidySuggestionDetail | null }
  entity: { request: { entityId: string }; result: BrainEntityView }
  memory: { request: { memoryId: string }; result: BrainMemoryDetail }
  resolve: { request: BrainResolve; result: BrainAgentWrite }
  relate: { request: BrainRelate; result: BrainAgentWrite }
  edit: { request: BrainEdit; result: BrainAgentWrite }
  correct: { request: BrainCorrect; result: BrainAgentWrite }
  erase: { request: BrainErase; result: BrainAgentWrite }
  undo: { request: BrainUndo; result: BrainAgentWrite }
}
export type BrainAgentMethod = keyof BrainAgentMap
/** Recall and flags for any lane. Queueing and changes stay with the Brain lane. */
export const BRAIN_LANE_METHODS = ['search', 'flag'] as const satisfies readonly BrainAgentMethod[]
export const BRAIN_CURATOR_METHODS = [
  'search',
  'waiting',
  'suggestion',
  'entity',
  'memory',
  'resolve',
  'relate',
  'edit',
  'correct',
  'erase',
  'undo',
] as const satisfies readonly BrainAgentMethod[]
