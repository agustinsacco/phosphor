import { expectTypeOf, it } from 'vitest'
import type {
  BrainConnectionPage,
  BrainEntityView,
  BrainExtractionView,
  BrainFindResult,
  BrainGraph,
  BrainLaneRef,
  BrainMemoryDetail,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainPaths,
  BrainPredicate,
  BrainPrefs,
  BrainProposalView,
  BrainReviewDecision,
  BrainStatus,
} from '../brain'

import type { BrainInvokeMap } from './brain'

/** UI commands. Authority comes from the Desktop handler, never this DTO. */
export interface BaselineBrainInvokeMap {
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
  'brain:proposal': { args: [jobId: string]; result: BrainProposalView }
  /** A null decision rejects the whole proposal. Refuses a stale revision. */
  'brain:review': {
    args: [jobId: string, decision: BrainReviewDecision | null, revision: number]
    result: BrainStatus
  }
  /** Deletes all knowledge, jobs and records. Keeps settings and the embedding model. */
  'brain:reset': { args: []; result: BrainStatus }
  /** Folds `sourceId` into `targetId`: names, links and memories move; the source is deleted. */
  'brain:merge': { args: [sourceId: string, targetId: string]; result: BrainStatus }
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
  /** Up to three shortest supported routes, at most four hops. */
  'brain:path': { args: [fromId: string, toId: string]; result: BrainPaths }
  /** Deletes one memory and any evidence no other memory cites. */
  'brain:forget': { args: [memoryId: string]; result: BrainStatus }
}

it('freezes the local-only Brain queue, review and explorer channels', () => {
  expectTypeOf<BrainInvokeMap>().toEqualTypeOf<BaselineBrainInvokeMap>()
})
