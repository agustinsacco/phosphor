import type { BrainTidyStore } from './tidy/types'
import type { BrainAgentStore } from './agent/types'
import type { BrainEntitySort, BrainEntitySummary } from '@phosphor/shared/brain-explore'
import type { BrainExpansion, BrainRecall, BrainRoutes } from '@phosphor/shared/brain-recall'
import type { BrainTidyTouched } from '@phosphor/shared/brain-tidy'
import type { DatabaseSync } from 'node:sqlite'
import type {
  BrainConnectionPage,
  BrainEntityView,
  BrainEntityKind,
  BrainEntityPage,
  BrainExtractionRecord,
  BrainFindResult,
  BrainGraph,
  BrainJob,
  BrainMemoryDetail,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainPredicate,
  BrainPrefs,
  BrainSnapshot,
} from '@phosphor/shared/brain'
import type {
  ClaimProbe,
  EntityCard,
  EntityMatch,
  MemoryCard,
  MemoryMatch,
  Proposal,
} from './proposal-types'

/** `node:sqlite`'s DatabaseSync, injected so Electron and plain Node load it their own way. */
export type SqliteDatabase = DatabaseSync
export interface SqliteOptions {
  readOnly?: boolean
  /** Busy timeout in milliseconds. */
  timeout?: number
}
export type SqliteConstructor = new (path: string, options?: SqliteOptions) => SqliteDatabase

export type NewJob = Pick<
  BrainJob,
  'sessionId' | 'sessionPath' | 'title' | 'scope' | 'branch' | 'model' | 'leafId'
> & { replaces?: string | null }
export type JobPatch = Partial<
  Pick<
    BrainJob,
    | 'state'
    | 'error'
    | 'startedAt'
    | 'runStartedAt'
    | 'finishedAt'
    | 'usage'
    | 'memories'
    | 'leafId'
    | 'model'
    | 'branch'
    | 'progress'
    | 'title'
  >
>
/** A checkpointed step of a job, reused only for identical input. */
export interface JobPart {
  part: string
  inputHash: string
  output: string
  /** First prepare checkpoint: persisted atomically with the job metadata. */
  prepare?: Pick<BrainJob, 'leafId' | 'model' | 'branch'> & { fromLeafId?: string | null }
}

/** What one saved read did. Held claims are counted here and in the read's record. */
export interface SavedRead {
  /** `empty` when nothing saved, nothing was confirmed and no group opened; nothing is journaled. */
  state: 'done' | 'empty'
  /** The `read` operation that undoes it; null when empty. */
  operationId: string | null
  memories: number
  confirmed: number
  /** Saved with an end BRAIN_TEMPORARY_DAYS after they were said. */
  temporary: number
  /** Never saved. */
  personal: number
  /** Unsure identities saved as new records, each with a `same_entity` guess. */
  guesses: number
  /** `group` suggestions opened. */
  groups: number
  /** Earlier memories of the lane that Read again removed. */
  replaced: number
  touched: BrainTidyTouched
}

/** The single writer: queue, saved reads and the Explorer's indexed reads. Synchronous. */
export interface BrainStore extends BrainTidyStore, BrainAgentStore {
  snapshot(): BrainSnapshot
  setPrefs(prefs: BrainPrefs): BrainPrefs
  revision(): number
  /** Memories, identities, names, links and states only; excludes Tidy bookkeeping. */
  knowledgeRevision(): number

  /** Throws when the lane already has an unfinished job, or nothing changed since the last one. */
  enqueue(job: NewJob, state: 'waiting' | 'queued'): BrainJob
  job(id: string): BrainJob | undefined
  /** The lane's newest finished read and what Read again would replace. */
  laneRead(sessionId: string): { job: BrainJob; memories: number; replaceable: number } | null
  /** The newest sixty current summaries from this lane, frozen into prepare context. */
  laneContext(sessionId: string): string[]
  /** All surviving memories from a lane, and those without independent support elsewhere. */
  laneMemories(sessionId: string, exceptJobId?: string): { ids: string[]; replaceable: string[] }
  updateJob(id: string, patch: JobPatch): BrainJob
  /** Requeues a failed job under the same id, keeping its parts and frozen leaf. */
  retry(id: string): BrainJob
  /** Deletes a job, its parts and its proposal. */
  removeJob(id: string): void
  /** Jobs left running by a previous app run go back to the queue. */
  requeueInterrupted(): void
  part(jobId: string, part: string, inputHash?: string): JobPart | undefined
  savePart(jobId: string, part: JobPart): void

  /** Exact, word and trigram candidates for each probe, at most `limit` each. */
  entityMatches(
    probes: { label: string; aliases: string[]; keys: { namespace: string; value: string }[] }[],
    limit: number,
  ): EntityMatch[][]
  entityCards(ids: string[]): EntityCard[]
  /**
   * Active or disputed memories that share a link or entities with each probe, and superseded
   * ones very close to it, at most `limit` per channel. Entity matches come from each entity's
   * newest memories, most similar first. Ids that are not stored entities (a job's new refs)
   * match nothing.
   */
  memoryMatches(probes: ClaimProbe[], limit: number): MemoryMatch[][]
  memoryCards(ids: string[]): MemoryCard[]

  /**
   * Commits a finished read in one transaction and one journal operation, and sets the job to
   * done or empty. Throws BRAIN_READ_STALE (`./read-stale`) when knowledge moved since
   * `proposal.computedRevision`.
   */
  saveRead(proposal: Proposal): SavedRead
  /** A legacy job's proposal, stored before v8 saved reads directly, until it is saved. */
  storedProposal(jobId: string): Proposal | undefined
  saveExtraction(record: BrainExtractionRecord): void
  extraction(jobId: string): BrainExtractionRecord & { memories: { id: string; summary: string }[] }

  overview(limit: number): BrainGraph
  neighbourhood(entityId: string, hops: 1 | 2, limit: number): BrainGraph
  entity(entityId: string): BrainEntityView
  connections(
    entityId: string,
    predicate: BrainPredicate,
    direction: 'out' | 'in',
    cursor: string | null,
  ): BrainConnectionPage
  entityMemories(
    entityId: string,
    filter: BrainMemoryFilter,
    cursor: string | null,
  ): BrainMemoryPage
  memory(id: string): BrainMemoryDetail
  merge(sourceId: string, targetId: string, revision: number): string
  forget(memoryId: string): void
  /** The entity that is you (`meta.owner_entity`), or null. */
  owner(): string | null
  /** Says which entity is you; null forgets it. Throws for an unknown entity. */
  setOwner(entityId: string | null): void
  /** Recall hits shown to a lane, counted in `memory_use`. No revision bump, no journal. */
  recordRecall(memoryIds: string[], at: number): void
  /**
   * Drops all knowledge, jobs, proposals and records in one transaction, recreates the schema,
   * keeps prefs and starts a new generation. Opening a v3 or older file does the same. Search
   * connections notice the generation change on `refresh`.
   */
  reset(): void
  close(): void
}

export interface SearchInput {
  query: string
  /** Query embedding; null falls back to words and names only. */
  vector: Float32Array | null
  limit: number
  /** The asking lane's project, ranked first. */
  scope: string | null
  /** The asking lane's branch; other-branch memories are returned apart. */
  branch: string | null
  now: number
}
export interface Neighbour {
  id: string
  score: number
}
/**
 * Read-only search over its own connection, with the sign-bit vector index in memory. Runs in
 * any process; `refresh` picks up rows committed since the last call.
 */
export interface BrainSearch {
  entities(
    kind: BrainEntityKind | null,
    offset: number,
    limit: number,
    sort: BrainEntitySort,
  ): BrainEntityPage
  /** Coalesced, chunked load; calls keep using the previous complete index while it refreshes. */
  refresh(): Promise<void>
  /** False while the vector index is still loading; searches then use words and names only. */
  ready(): boolean
  recall(input: SearchInput): BrainRecall
  /** One entity's relationships, the entities named with it, and its memories ranked from it. */
  expand(input: {
    entityId: string
    /** Entities that steer the ranking. */
    contextIds: string[]
    limit: number
    scope: string | null
    branch: string | null
    now: number
  }): BrainExpansion
  /** Up to three routes between two entities, through links or memories naming both. */
  routes(fromId: string, toId: string, now: number): BrainRoutes
  /** Exact name, alias or key matches for each text, best first. An id resolves to itself. */
  resolve(names: string[]): BrainEntitySummary[][]
  find(query: string, vector: Float32Array | null, limit: number): BrainFindResult
  nearestEntities(vectors: Float32Array[], k: number): Neighbour[][]
  nearestMemories(vectors: Float32Array[], k: number): Neighbour[][]
  close(): void
}

export interface OpenStoreOptions {
  /** Path of the SQLite file; its directory must exist. */
  path: string
  Database: SqliteConstructor
  now?: () => number
  id?: () => string
}
export type * from './proposal-types'
