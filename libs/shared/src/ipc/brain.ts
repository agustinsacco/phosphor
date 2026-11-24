import type { BrainTidyChanges, BrainTidyMutation } from '../brain-tidy'
import type {
  BrainConnectionPage,
  BrainEntityView,
  BrainEntityKind,
  BrainEntityPage,
  BrainExtractionView,
  BrainFindResult,
  BrainGraph,
  BrainJob,
  BrainLaneRef,
  BrainMemoryDetail,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainPredicate,
  BrainPrefs,
  BrainStatus,
  BrainUndoRunResult,
} from '../brain'
import type { BrainRecall, BrainRoutes } from '../brain-recall'

/** UI commands. Authority comes from the Desktop handler, never this DTO. */
export interface BrainInvokeMap {
  'brain:tidyChanges': { args: [limit: number]; result: BrainTidyChanges }
  'brain:tidyUndo': { args: [operationId: string, revision: number]; result: BrainStatus }
  /** Starts Defrag, or queues it behind reads already queued. Refused while one is queued or running. */
  'brain:defrag': { args: []; result: BrainStatus }
  /** Stops the queued or running Defrag. Changes it already made stay and can be undone. */
  'brain:defragStop': { args: []; result: BrainStatus }
  /** Undoes every change of a Defrag run that can still be undone. Erasures stay. */
  'brain:undoRun': { args: [runId: string]; result: BrainUndoRunResult }
  'brain:entities': {
    args: [
      kind: BrainEntityKind | null,
      offset: number,
      limit: number,
      sort: 'connected' | 'recent' | 'name',
    ]
    result: BrainEntityPage
  }
  /** Recall with no project: up to 8 hits with their trails, for the Brain page's Ask bar. */
  'brain:ask': { args: [question: string]; result: BrainRecall }
  /** Sends an ordinary message to Brain Agent in the Brain lane, owned by no run. */
  'brain:tell': { args: [message: string]; result: { sessionPath: string | null } }
  /** The lane's newest finished read and what Read again would replace; null if never read. */
  'brain:laneRead': {
    args: [sessionId: string]
    result: { job: BrainJob; memories: number; replaceable: number } | null
  }
  /** Says which entity is you, so the map centres on it; null forgets it. */
  'brain:setOwner': { args: [entityId: string | null]; result: BrainStatus }
  /** Reads the lane again from the start; its earlier unshared memories are replaced on save. */
  'brain:reread': { args: [jobId: string]; result: BrainStatus }
  'brain:neverRead': { args: [sessionId: string, never: boolean]; result: BrainStatus }
  'brain:status': { args: []; result: BrainStatus }
  /** Saves at once. Enabling downloads the model if it is missing; disabling keeps it. */
  'brain:setPrefs': { args: [prefs: BrainPrefs]; result: BrainStatus }
  /** Retries a failed model download. */
  'brain:download': { args: []; result: BrainStatus }
  'brain:removeModel': { args: []; result: BrainStatus }
  'brain:queue': { args: [lane: BrainLaneRef]; result: BrainStatus }
  /** Cancels a waiting, queued or running job, or dismisses an empty or failed one. */
  'brain:cancel': { args: [jobId: string]; result: BrainStatus }
  /** Requeues a failed job under the same id; finished steps are reused. */
  'brain:retry': { args: [jobId: string]; result: BrainStatus }
  'brain:extraction': { args: [jobId: string]; result: BrainExtractionView }
  /** Deletes all knowledge, jobs and records. Keeps settings and the embedding model. */
  'brain:reset': { args: []; result: BrainStatus }
  /** Folds `sourceId` into `targetId`: names, links and memories move; the source is deleted. */
  'brain:merge': {
    args: [sourceId: string, targetId: string, revision: number]
    result: BrainTidyMutation
  }
  /** Replaces an entity's description (trimmed, 1–160 characters). Undoable. */
  'brain:describe': {
    args: [entityId: string, description: string, revision: number]
    result: BrainTidyMutation
  }
  /** Removes one alias, never the label. Undoable; refuses a stale revision. */
  'brain:removeName': {
    args: [entityId: string, name: string, revision: number]
    result: BrainTidyMutation
  }
  /**
   * Moves 1–200 of an entity's memories, with the mentions and links they support, to a new
   * entity named `target.label`. The original keeps the rest and its aliases. Undoable.
   */
  'brain:split': {
    args: [
      entityId: string,
      memoryIds: string[],
      target: { label: string; kind: BrainEntityKind },
      revision: number,
    ]
    result: BrainTidyMutation
  }
  /** Typeahead over entities and memories. */
  'brain:find': { args: [query: string, limit: number]; result: BrainFindResult }
  /** The best-connected entities, when nothing is selected. */
  'brain:overview': { args: []; result: BrainGraph }
  /** One entity's neighbourhood, one or two hops out. */
  'brain:neighbourhood': { args: [entityId: string, hops: 1 | 2]; result: BrainGraph }
  'brain:entity': { args: [entityId: string]; result: BrainEntityView }
  'brain:connections': {
    args: [
      entityId: string,
      predicate: BrainPredicate,
      direction: 'out' | 'in',
      cursor: string | null,
    ]
    result: BrainConnectionPage
  }
  'brain:entityMemories': {
    args: [entityId: string, filter: BrainMemoryFilter, cursor: string | null]
    result: BrainMemoryPage
  }
  'brain:memory': { args: [memoryId: string]; result: BrainMemoryDetail }
  /** Up to three routes, at most four steps, through links or memories naming both. */
  'brain:path': { args: [fromId: string, toId: string]; result: BrainRoutes }
  /** Deletes one memory and any evidence no other memory cites. */
  'brain:forget': { args: [memoryId: string]; result: BrainStatus }
}
