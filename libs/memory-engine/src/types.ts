import type { DatabaseSync } from 'node:sqlite'
import type {
  BrainEntity,
  BrainEntityKind,
  BrainEpistemicKind,
  BrainJob,
  BrainKnowledge,
  BrainMemory,
  BrainMemoryDetail,
  BrainMemoryType,
  BrainOrigin,
  BrainPredicate,
  BrainPrefs,
  BrainProposalView,
  BrainRecall,
  BrainSnapshot,
} from '@phosphor/shared/brain'

/** `node:sqlite`'s DatabaseSync, injected so Electron and plain Node load it their own way. */
export type SqliteDatabase = DatabaseSync
export type SqliteConstructor = new (path: string) => SqliteDatabase

/** One readable piece of a lane transcript: a message, tool output, tool call or summary. */
export interface TranscriptSegment {
  entryId: string
  role: 'user' | 'assistant' | 'toolResult' | 'context'
  /** Human label, for example "Agent · bash call · Nov 6, 12:47". */
  label: string
  observedAt: number
  text: string
}

/** Transcript text kept around cited quotes, so memories outlive their lane. */
export interface EvidenceExcerpt {
  entryId: string
  role: TranscriptSegment['role']
  label: string
  observedAt: number
  text: string
}

/** The fork's JSON after parsing and vocabulary checks, before quotes are verified. */
export interface RawExtraction {
  summary: string
  entities: RawEntity[]
  memories: RawMemory[]
}
export interface RawEntity {
  key: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
}
export interface RawMemory {
  /** Entity key, or the id of an existing entity the prompt listed. */
  subject: string
  predicate: BrainPredicate
  object: string | null
  literal: string | null
  summary: string
  kind: BrainEpistemicKind
  type: BrainMemoryType
  /** True when the memory only holds on the lane's own branch. */
  branch: boolean
  validFrom: number | null
  quotes: string[]
  /** Id of an existing memory, from the prompt's list, that this one replaces. */
  supersedes: string | null
}

/** A proposal ready to store: quotes verified, evidence excerpted, vectors attached. */
export interface Extraction {
  jobId: string
  summary: string
  origin: BrainOrigin
  scope: string
  branch: string | null
  entities: RawEntity[]
  memories: (Omit<RawMemory, 'quotes'> & { citations: { evidence: number; quote: string }[] })[]
  evidence: EvidenceExcerpt[]
  /** One vector per memory, in order. */
  vectors: Float32Array[]
}

export type NewJob = Pick<
  BrainJob,
  'sessionId' | 'sessionPath' | 'title' | 'scope' | 'branch' | 'model' | 'leafId'
>
export type JobPatch = Partial<
  Pick<
    BrainJob,
    | 'state'
    | 'error'
    | 'startedAt'
    | 'finishedAt'
    | 'usage'
    | 'memories'
    | 'leafId'
    | 'model'
    | 'branch'
  >
>

/** What the extraction prompt shows the fork, so it reuses entities and skips known memories. */
export interface KnownContext {
  entities: BrainEntity[]
  memories: BrainMemory[]
}

export interface SearchInput {
  query: string
  /** Query embedding; null falls back to words and names only. */
  vector: Float32Array | null
  limit: number
  /** The asking lane's project, ranked first. */
  scope: string | null
}

/** The one store for knowledge, the queue and proposals. All methods are synchronous. */
export interface BrainStore {
  snapshot(): BrainSnapshot
  setPrefs(prefs: BrainPrefs): BrainPrefs

  /** Throws when the lane already has an unfinished job, or nothing changed since the last one. */
  enqueue(job: NewJob, state: 'waiting' | 'queued'): BrainJob
  job(id: string): BrainJob | undefined
  updateJob(id: string, patch: JobPatch): BrainJob
  /** Deletes a job and its proposal. */
  removeJob(id: string): void
  /** Jobs left running by a previous app run go back to the queue. */
  requeueInterrupted(): void

  /** Drops near-duplicates of each other and of active memories, then stores the rest. */
  propose(extraction: Extraction): { kept: number; duplicates: number }
  proposal(jobId: string): BrainProposalView
  /** `keep` is the proposal memory indexes to approve; null rejects all. Refuses a stale revision. */
  review(jobId: string, keep: number[] | null, revision: number): void

  knowledge(limit?: number): BrainKnowledge
  memory(id: string): BrainMemoryDetail
  forget(memoryId: string): void
  /** Existing entities and memories for an extraction prompt about this lane. */
  known(sessionId: string, scope: string, limit: number): KnownContext

  search(input: SearchInput): BrainRecall
  related(entity: string, limit: number, scope: string | null): BrainRecall
  recordDelivery(sessionId: string, memoryIds: string[]): void
  close(): void
}

export interface OpenStoreOptions {
  /** Path of the SQLite file; its directory must exist. */
  path: string
  Database: SqliteConstructor
  now?: () => number
  id?: () => string
}
export type { BrainMemory, BrainEntity }
