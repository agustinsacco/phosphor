import type { BrainTidySummary } from './brain-tidy'
import type { BrainAgentMethod, BrainAgentStatus } from './brain-agent'

/**
 * Brain: machine-local knowledge learned only from lanes the user queues. Private model calls
 * read the conversation in parts, the user approves what they propose, and every lane can recall it.
 * No credentials or database paths cross this contract.
 */
export const BRAIN_PROTOCOL = 6
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
  'leads',
] as const
export type BrainPredicate = (typeof BRAIN_PREDICATES)[number]
/** Extraction-only endpoint rules; review may re-point an identity across kinds. */
export const BRAIN_LINK_RULES: Record<
  BrainPredicate,
  { subject: readonly BrainEntityKind[]; object: readonly BrainEntityKind[] }
> = {
  owns: {
    subject: ['person', 'team', 'organization'],
    object: ['project', 'component', 'document'],
  },
  works_on: { subject: ['person', 'team'], object: ['project', 'component', 'document'] },
  member_of: { subject: ['person', 'team'], object: ['team', 'organization'] },
  part_of: {
    subject: ['component', 'project', 'document', 'team'],
    object: ['component', 'project', 'team', 'organization'],
  },
  for_customer: { subject: ['project', 'component', 'document', 'team'], object: ['organization'] },
  documents: {
    subject: ['document'],
    object: ['project', 'component', 'concept', 'team', 'organization', 'event'],
  },
  depends_on: {
    subject: ['component', 'project'],
    object: ['component', 'project', 'organization'],
  },
  uses: {
    subject: ['component', 'project', 'team', 'person', 'organization'],
    object: ['component', 'project', 'organization', 'concept', 'document'],
  },
  decided: {
    subject: ['person', 'team', 'organization'],
    object: ['project', 'component', 'document', 'concept', 'event'],
  },
  prefers: {
    subject: ['person', 'team', 'organization'],
    object: ['component', 'project', 'concept', 'document', 'organization'],
  },
  leads: { subject: ['person'], object: ['team', 'project'] },
}
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
  leads: { out: 'Leads', in: 'Led by' },
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
  /** Lane agents get brain_search and brain_flag. */
  recall: boolean
  /** Extracted memories wait for approval; off saves them as soon as extraction ends. */
  review: boolean
  /** Reader provider/modelId; null uses each lane's own model. Frozen when a job starts. */
  model: string | null
  /** Whole-word title patterns and individually excluded lanes. */
  neverRead: { titles: string[]; sessionIds: string[] }
}
export const DEFAULT_BRAIN_PREFS: BrainPrefs = {
  enabled: false,
  recall: true,
  review: true,
  model: null,
  neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
}

/** This value becomes one --model argument, never an option or multiple arguments. */
export function checkBrainReaderModel(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    value.startsWith('-') ||
    /[\s\p{Cc}]/u.test(value) ||
    value.indexOf('/') <= 0 ||
    value.indexOf('/') === value.length - 1
  )
    throw new Error(
      'Invalid Brain reader model: use provider/modelId (at most 200 characters, no whitespace or control characters), or null.',
    )
  return value
}

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

export type BrainJobStage = 'prepare' | 'extract' | 'identity' | 'reconcile' | 'embed'
export type BrainJobState =
  | 'waiting'
  | 'queued'
  | 'running'
  | 'refreshing'
  | 'review'
  | 'empty'
  | 'failed'
  | 'done'
  | 'rejected'
/** One lane read. Up to twenty finished reads per lane retain their leaves and records. */
export interface BrainJob {
  id: string
  /** Earlier finished read; replacement happens only when the new result is approved. */
  replaces: string | null
  sessionId: string
  sessionPath: string
  title: string
  scope: string
  branch: string | null
  /** "provider/id" of the reader, frozen when extraction starts and reused by every call. */
  model: string
  /** waiting: the lane's agent is working; extraction starts once it is idle. */
  state: BrainJobState
  /** Memories proposed by the run, shown as the review count. */
  memories: number
  /** Last lane entry the run reads; frozen when the job first starts. */
  leafId: string | null
  error: string | null
  queuedAt: number
  /** First start, unchanged by retries or refreshes. */
  startedAt: number | null
  /** Current attempt start, or null outside a running attempt. */
  runStartedAt: number | null
  /** Continue after this lane entry; null starts from the beginning. */
  fromLeafId: string | null
  finishedAt: number | null
  usage: { tokens: number; cost: number } | null
  /** Where a running job is: `done` of `total` steps in `stage`. */
  progress: { stage: BrainJobStage; done: number; total: number } | null
}
export interface BrainHistory {
  items: {
    job: BrainJob
    /** Current (active or disputed) memories produced by this read, never superseded ones. */
    memories: number
    /** Unshared memories across the whole lane that Read again replaces, including older reads. */
    replaceable: number
  }[]
  more: boolean
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
  /** General change counter for explorer and Tidy guards; reviews use a knowledge-only guard. */
  revision: number
  /** New after every reset, so views reload even when the revision repeats. */
  generation: string
  counts: { memories: number; entities: number }
  /** The newest 5,000 lane ids with a finished read (done, empty or rejected). */
  readSessionIds: string[]
  /** The inbox: every job that is not done, oldest first. */
  jobs: BrainJob[]
}
export interface BrainStatus extends BrainSnapshot {
  tidy: BrainTidySummary
  agent: BrainAgentStatus
  supported: boolean
  embedding: BrainEmbeddingStatus
}
/** The title the caller shows, empty for an untitled lane. Brain reads the current title from the file. */
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
export interface BrainFlagResponse {
  status: 'filed' | 'already_flagged' | 'limit' | 'unavailable'
  message: string
}
export type {
  BrainAgentMap,
  BrainAgentMethod,
  BrainAgentRun,
  BrainAgentRunState,
  BrainAgentStatus,
  BrainUndoRunResult,
  BrainWaitingCounts,
} from './brain-agent'
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
  BrainEntityPage,
  BrainRecentMemory,
  BrainRecentMemories,
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

export {
  brainLaneNeverRead,
  brainNeverReadReason,
  brainTitleNeverRead,
  checkBrainNeverRead,
  setBrainLaneNeverRead,
} from './brain-never-read'
