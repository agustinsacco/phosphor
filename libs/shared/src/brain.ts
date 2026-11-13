/**
 * Brain: machine-local knowledge learned only from lanes the user queues. Private model calls
 * read the lane in windows, the user approves what they propose, and every lane can recall it.
 * No credentials or database paths cross this contract.
 */
export const BRAIN_PROTOCOL = 4
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
/** Node labels. A kind describes an entity; it is never part of its identity. */
export const BRAIN_ENTITY_KINDS = [
  'person',
  'team',
  'organization',
  'project',
  'component',
  'document',
  'ticket',
  'concept',
  'event',
] as const
export type BrainEntityKind = (typeof BRAIN_ENTITY_KINDS)[number]
/** Directed relationship types, read subject → object. A memory can state several. */
export const BRAIN_PREDICATES = [
  'owns',
  'works_on',
  'member_of',
  'part_of',
  'for_customer',
  'documents',
  'depends_on',
  'uses',
  'decided',
  'prefers',
  'blocks',
  'affects',
  'related_to',
] as const
export type BrainPredicate = (typeof BRAIN_PREDICATES)[number]
/** Predicates that place an entity: recall follows them one hop further than the rest. */
export const BRAIN_STRUCTURAL_PREDICATES = [
  'part_of',
  'for_customer',
  'owns',
  'member_of',
  'documents',
] as const satisfies readonly BrainPredicate[]
/** Plain words for each predicate, from the subject's side and from the object's side. */
export const BRAIN_PREDICATE_LABELS: Record<BrainPredicate, { out: string; in: string }> = {
  owns: { out: 'Owns', in: 'Owned by' },
  works_on: { out: 'Works on', in: 'Worked on by' },
  member_of: { out: 'Member of', in: 'Members' },
  part_of: { out: 'Part of', in: 'Contains' },
  for_customer: { out: 'For customer', in: 'Customer of' },
  documents: { out: 'Documents', in: 'Documented in' },
  depends_on: { out: 'Depends on', in: 'Needed by' },
  uses: { out: 'Uses', in: 'Used by' },
  decided: { out: 'Decided', in: 'Decided by' },
  prefers: { out: 'Prefers', in: 'Preferred by' },
  blocks: { out: 'Blocks', in: 'Blocked by' },
  affects: { out: 'Affects', in: 'Affected by' },
  related_to: { out: 'Related to', in: 'Related to' },
}
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
/** `superseded` was replaced by a later memory; `disputed` conflicts with another one. */
export const BRAIN_MEMORY_STATES = ['active', 'superseded', 'disputed'] as const
export type BrainMemoryState = (typeof BRAIN_MEMORY_STATES)[number]

export interface BrainPrefs {
  enabled: boolean
  /** Lane agents get brain_search. */
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
  /** Short evidence-derived disambiguator, at most 160 characters. */
  description: string
}
/** The lane a memory was learned from. Kept after the lane is deleted. */
export interface BrainOrigin {
  sessionId: string
  title: string
}
/** One directed relationship, stated and supported by one memory. */
export interface BrainLink {
  id: string
  subjectId: string
  predicate: BrainPredicate
  objectId: string
  memoryId: string
}
/** One approved memory: a self-contained sentence, the entities it names and the links it states. */
export interface BrainMemory {
  id: string
  jobId: string | null
  summary: string
  type: BrainMemoryType
  kind: BrainEpistemicKind
  state: BrainMemoryState
  /** Every entity the memory names, linked or not. */
  entityIds: string[]
  links: BrainLink[]
  /** Project root the lane ran in; memories are searchable from every project. */
  scope: string
  /** Branch the memory applies to; null applies to the whole project. */
  branch: string | null
  /** When it took effect and stopped applying, if the lane said. */
  validFrom: number | null
  validTo: number | null
  /** When it was approved. */
  recordedAt: number
  /** When a lane last said it: its latest independent citation. Search ranks by its age. */
  observedAt: number
  origin: BrainOrigin | null
}
export interface BrainQuote {
  quote: string
  before: string
  after: string
  label: string
}

export type BrainJobStage = 'prepare' | 'extract' | 'identity' | 'parents' | 'reconcile' | 'embed'
/** Queue entry for one lane. `done` entries stay only to refuse re-queuing an unchanged lane. */
export interface BrainJob {
  id: string
  sessionId: string
  sessionPath: string
  title: string
  scope: string
  branch: string | null
  /** "provider/id" of the lane's model, which every extraction call reuses. */
  model: string
  /** waiting: the lane's agent is working; extraction starts once it is idle. */
  state: 'waiting' | 'queued' | 'running' | 'review' | 'empty' | 'failed' | 'done'
  /** Memories proposed by the run, shown as the review count. */
  memories: number
  /** Last lane entry the run reads; frozen when the job first starts. */
  leafId: string | null
  error: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  usage: { tokens: number; cost: number } | null
  /** Where a running job is: `done` of `total` steps in `stage`. */
  progress: { stage: BrainJobStage; done: number; total: number } | null
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
  /** New after every reset, so views reload even when the revision repeats. */
  generation: string
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

/** What a lane agent sends. `cwd` ranks the lane's own project first and picks its branch. */
export interface BrainQuery {
  query: string
  limit?: number
  sessionId?: string
  cwd?: string
}
export interface BrainHit {
  memory: BrainMemory
  score: number
  /** `exact`: names a queried entity. `linked`: reached by walking links from one. */
  reasons: ('exact' | 'lexical' | 'semantic' | 'linked')[]
}
export interface BrainRecall {
  status: 'ok' | 'no_match' | 'unavailable'
  hits: BrainHit[]
  /** Every entity the hits, focus and paths reference, so tools can print names. */
  entities: BrainEntity[]
  /** Entity ids the query named, or sits inside: "NRS" names every NRS project. */
  focus: string[]
  /** Supported routes out of the focus, each hop citing the memory that states it. */
  paths: BrainLink[][]
  /** Strong matches the limit left out, counted up to 50. */
  more: number
  /** The asking lane's branch; memories for other branches are listed apart. */
  branch: string | null
  degradation: string[]
}
export type { BrainInvokeMap } from './ipc/brain'
/** Lane agents can only read. Approval, queueing and forgetting stay with the user. */
export interface BrainAgentMap {
  search: { request: BrainQuery; result: BrainRecall }
}
export type BrainAgentMethod = keyof BrainAgentMap
export interface BrainAgentRequest {
  version: typeof BRAIN_PROTOCOL
  token: string
  method: BrainAgentMethod
  params: unknown
}
export type BrainAgentResponse = { ok: true; data: unknown } | { ok: false; error: string }

export type {
  BrainSourceSegment,
  BrainExtractionCall,
  BrainExtractionRecord,
  BrainExtractionOutcome,
  BrainExtractionView,
} from './brain-extraction'
export type {
  BrainEntitySummary,
  BrainGraph,
  BrainConnection,
  BrainConnectionGroup,
  BrainConnectionPage,
  BrainEntityView,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainMemoryDetail,
  BrainFindResult,
  BrainPaths,
} from './brain-explore'
export type {
  BrainIdentity,
  BrainGroupQuestion,
  BrainProposedLink,
  BrainProposedMemory,
  BrainProposalView,
  BrainReviewDecision,
} from './brain-review'
