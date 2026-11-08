/**
 * Brain: machine-local knowledge learned only from lanes the user queues. A private fork
 * of the lane extracts memories, the user approves them, and every lane can recall them.
 * No credentials or database paths cross this contract.
 */
export const BRAIN_PROTOCOL = 2
/** Pinned local embedding model. No hosted embedding or silent model fallback. */
export const BRAIN_EMBEDDING_MODEL = {
  id: 'embeddinggemma-300m-q4@5090578d9565bb06545b4552f76e6bc2c93e4a66',
  label: 'EmbeddingGemma 300M · Q4',
  dimensions: 768,
  downloadBytes: 218_726_989,
  modelUrl: 'https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX',
  termsUrl: 'https://ai.google.dev/gemma/terms',
  usePolicyUrl: 'https://ai.google.dev/gemma/prohibited_use_policy',
} as const
/** Node labels: a small fixed schema, as Neo4j's KG builder and GraphRAG recommend. */
export const BRAIN_ENTITY_KINDS = [
  'person',
  'team',
  'organization',
  'project',
  'component',
  'document',
  'concept',
  'event',
] as const
export type BrainEntityKind = (typeof BRAIN_ENTITY_KINDS)[number]
/** Relationship types between two entities. `about` attaches a literal fact to one entity. */
export const BRAIN_PREDICATES = [
  'owns',
  'works_on',
  'member_of',
  'part_of',
  'depends_on',
  'uses',
  'decided',
  'prefers',
  'blocks',
  'affects',
  'related_to',
  'about',
] as const
export type BrainPredicate = (typeof BRAIN_PREDICATES)[number]
/** What a memory is for; the extractor picks one and the UI groups by it, in this order. */
export const BRAIN_MEMORY_TYPES = [
  'decision',
  'open',
  'risk',
  'procedure',
  'preference',
  'fact',
] as const
export type BrainMemoryType = (typeof BRAIN_MEMORY_TYPES)[number]
export type BrainEpistemicKind = 'observed' | 'reported' | 'inferred'

export interface BrainPrefs {
  enabled: boolean
  /** Lane agents get brain_search and brain_related. */
  recall: boolean
  /** Extracted memories wait for approval; off saves them as soon as extraction ends. */
  review: boolean
}
export const DEFAULT_BRAIN_PREFS: BrainPrefs = { enabled: false, recall: true, review: true }

export interface BrainEntity {
  id: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
}
/** The lane a memory was learned from. Kept after the lane is deleted. */
export interface BrainOrigin {
  sessionId: string
  title: string
}
/** One approved memory: a sentence, plus the graph edge or attribute it states. */
export interface BrainMemory {
  id: string
  summary: string
  type: BrainMemoryType
  kind: BrainEpistemicKind
  subjectId: string
  predicate: BrainPredicate
  /** Set when the memory links two entities; otherwise `literal` holds the value. */
  objectId: string | null
  literal: string | null
  /** Project root the lane ran in; memories are searchable from every project. */
  scope: string
  /** Branch the memory applies to; null applies to the whole project. */
  branch: string | null
  validFrom: number | null
  recordedAt: number
  origin: BrainOrigin | null
}
export interface BrainQuote {
  quote: string
  before: string
  after: string
  label: string
}

/** Queue entry for one lane. `done` entries stay only to refuse re-queuing an unchanged lane. */
export interface BrainJob {
  id: string
  sessionId: string
  sessionPath: string
  title: string
  scope: string
  branch: string | null
  /** "provider/id" of the lane's model, which the private fork reuses. */
  model: string
  /** waiting: the lane's agent is working; the fork starts once it is idle. */
  state: 'waiting' | 'queued' | 'running' | 'review' | 'empty' | 'failed' | 'done'
  /** Memories proposed by the run, shown as the review count. */
  memories: number
  /** Last lane entry the run read. */
  leafId: string | null
  error: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  usage: { tokens: number; cost: number } | null
}
export interface BrainEmbeddingStatus {
  phase: 'missing' | 'downloading' | 'verifying' | 'testing' | 'ready' | 'error' | 'unsupported'
  receivedBytes: number
  totalBytes: number
  error?: string
  modelId: string
  dimensions: number
}
export interface BrainSnapshot {
  prefs: BrainPrefs
  /** Bumped by every approved change; review refuses a stale revision. */
  revision: number
  counts: { memories: number; entities: number }
  /** The inbox: every job that is not done, oldest first. */
  jobs: BrainJob[]
}
export interface BrainStatus extends BrainSnapshot {
  supported: boolean
  embedding: BrainEmbeddingStatus
}
/** The sidebar knows a lane's live title; the handler reads everything else from the file. */
export interface BrainLaneRef {
  sessionPath: string
  title: string
}
export interface BrainKnowledge {
  entities: BrainEntity[]
  memories: BrainMemory[]
  truncated: boolean
}
export interface BrainMemoryDetail {
  memory: BrainMemory
  quotes: BrainQuote[]
}
export interface BrainProposalView {
  job: BrainJob
  /** The fork's one-paragraph account of the lane. */
  summary: string
  revision: number
  /** Proposed and existing entities the memories reference; proposed ones use their key as id. */
  entities: BrainEntity[]
  /** Proposed memories in proposal order; review keeps them by index. */
  memories: BrainMemoryDetail[]
}

/** What a lane agent sends. `cwd` ranks the lane's own project first; `sessionId` records delivery. */
export interface BrainQuery {
  query: string
  limit?: number
  sessionId?: string
  cwd?: string
}
export interface BrainHit {
  memory: BrainMemory
  score: number
  reasons: ('exact' | 'lexical' | 'semantic')[]
}
export interface BrainRecall {
  status: 'ok' | 'no_match' | 'unavailable'
  hits: BrainHit[]
  /** Entities the hits reference, so tools can print names. */
  entities: BrainEntity[]
  degradation: string[]
}
export type { BrainInvokeMap } from './ipc/brain'
/** Lane agents can only read. Approval, queueing and forgetting stay with the user. */
export interface BrainAgentMap {
  search: { request: BrainQuery; result: BrainRecall }
  /** Memories about one entity (by id or name) and the entities linked to it. */
  related: { request: Omit<BrainQuery, 'query'> & { entity: string }; result: BrainRecall }
}
export type BrainAgentMethod = keyof BrainAgentMap
export interface BrainAgentRequest {
  version: typeof BRAIN_PROTOCOL
  token: string
  method: BrainAgentMethod
  params: unknown
}
export type BrainAgentResponse = { ok: true; data: unknown } | { ok: false; error: string }
