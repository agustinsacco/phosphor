/**
 * Brain Agent: the agent of the Brain lane, an ordinary lane in Brain's own folder. Defrag
 * sends it what is waiting, and it decides each item with the curator tools below. Every
 * surface names it Brain Agent, never its model.
 */
import type {
  BrainEntityKind,
  BrainFlagResponse,
  BrainQuery,
  BrainRecall,
  BrainStatus,
} from './brain'
import type { BrainEntityView, BrainMemoryDetail } from './brain-explore'
import type { BrainProposalView } from './brain-review'
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

/** What Defrag decides, counted the way the page header shows it. */
export interface BrainWaitingCounts {
  /** Reads in review or refreshing. */
  reads: number
  /** Open "same person or thing" suggestions. */
  entities: number
  /** Open "said twice" suggestions. */
  repeats: number
  /** Open disagreements. */
  conflicts: number
  /** Open flags from lanes. */
  flags: number
}

export type BrainAgentRunState = 'queued' | 'running' | 'done' | 'stopped' | 'failed'
/** One Defrag run. The latest stays in status, with Undo run, until the next one starts. */
export interface BrainAgentRun {
  id: string
  state: BrainAgentRunState
  /** Items waiting when the run started (the header count); 0 while queued. */
  total: number
  /** Brain Agent changes in this run so far, erasures and rejections included. */
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
}
export interface BrainAgentStatus {
  waiting: BrainWaitingCounts
  /** The latest Defrag run, until the next one starts. */
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
  | 'read'
  | 'same_entity'
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
export type BrainWaitingItem =
  | {
      kind: 'read'
      jobId: string
      title: string
      state: 'review' | 'refreshing'
      memories: number
      /** Identity and group questions, required ones included. */
      questions: number
      /** The lane's current title or id is set never to be read: reject it. */
      neverRead: boolean
      finishedAt: number | null
    }
  | {
      kind: Exclude<BrainWaitingKind, 'read'>
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
/** A waiting read as the runtime formats it for Brain Agent, one page at a time. */
export interface BrainReadReview {
  proposal: BrainProposalView
  neverRead: boolean
}
export interface BrainReadReviewRequest {
  jobId: string
  /** Where the previous page said to go on, counted across the read's entries; 0 when left out. */
  offset?: number
}
/**
 * One page of a waiting read, formatted in the main process: a long read is larger than a bridge
 * frame, so no answer carries the whole proposal.
 */
export interface BrainReadReviewPage {
  text: string
}

/** Every write names why, in one sentence. */
export interface BrainAgentReason {
  reason: string
}
/**
 * Approve or reject a whole read with Brain Agent's own brain_decide_read parameters. The runtime
 * builds the decision against the stored proposal: unless `memories` lists them, every memory that
 * is not held.
 */
export interface BrainDecideRead extends BrainAgentReason {
  jobId: string
  /** The `revision` of the review Brain Agent decided on; a refreshed review is refused. */
  revision: number
  /** False rejects the whole read and ignores the choices below. */
  approve: boolean
  /** Memory indexes to save, from any page. */
  memories?: number[]
  /** Identity answers: an existing entity id, or "new". */
  identities?: { ref: string; answer: string }[]
  /** Group question indexes confirmed. */
  groups?: number[]
  /** Identity refs whose description from this read replaces the stored one. */
  descriptions?: string[]
  /** Held "said again" indexes to save. */
  confirmations?: number[]
}
export interface BrainResolve extends BrainAgentReason {
  suggestionId: string
  /** Erasing goes through `erase`, so the hourly cap holds. */
  action: Exclude<BrainTidyAction, { kind: 'forget' }>
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
}
export interface BrainErase extends BrainAgentReason {
  memoryId: string
}
export interface BrainUndo extends BrainAgentReason {
  operationId: string
}
export interface BrainAgentWrite {
  /**
   * done: saved, and `operationId` can undo it (null for an erasure). changed: the read was
   * refreshed since Brain Agent read it; read it again. refused: nothing changed, `message`
   * says why. limit: the hourly erase cap.
   */
  status: 'done' | 'changed' | 'refused' | 'limit'
  message: string
  operationId: string | null
}

/** Bridge methods. Any lane's token calls BRAIN_LANE_METHODS; only the Brain lane's calls the rest. */
export interface BrainAgentMap {
  search: { request: BrainQuery; result: BrainRecall }
  flag: { request: BrainTidyFlag; result: BrainFlagResponse }
  waiting: { request: { limit?: number }; result: BrainWaiting }
  readReview: { request: BrainReadReviewRequest; result: BrainReadReviewPage }
  suggestion: { request: { suggestionId: string }; result: BrainTidySuggestionDetail | null }
  entity: { request: { entityId: string }; result: BrainEntityView }
  memory: { request: { memoryId: string }; result: BrainMemoryDetail }
  decideRead: { request: BrainDecideRead; result: BrainAgentWrite }
  resolve: { request: BrainResolve; result: BrainAgentWrite }
  edit: { request: BrainEdit; result: BrainAgentWrite }
  correct: { request: BrainCorrect; result: BrainAgentWrite }
  erase: { request: BrainErase; result: BrainAgentWrite }
  undo: { request: BrainUndo; result: BrainAgentWrite }
}
export type BrainAgentMethod = keyof BrainAgentMap
/** Recall and flags for owner review. Approval, queueing and changes stay with the Brain lane. */
export const BRAIN_LANE_METHODS = ['search', 'flag'] as const satisfies readonly BrainAgentMethod[]
export const BRAIN_CURATOR_METHODS = [
  'search',
  'waiting',
  'readReview',
  'suggestion',
  'entity',
  'memory',
  'decideRead',
  'resolve',
  'edit',
  'correct',
  'erase',
  'undo',
] as const satisfies readonly BrainAgentMethod[]
