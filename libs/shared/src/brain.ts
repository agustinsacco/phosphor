import type { BrainTidySummary } from './brain-tidy'
import type { BrainAgentMethod, BrainAgentStatus } from './brain-agent'
import type { BrainLink } from './brain-links'

/**
 * Brain: machine-local knowledge learned only from lanes the user queues. Private model calls
 * read the conversation in parts, the read saves what they find when it finishes, Brain Agent
 * tidies it, and every lane can recall it. No credentials or database paths cross this contract.
 */
export const BRAIN_PROTOCOL = 7
export const BRAIN_ASK_MAX = 2000
export const BRAIN_TELL_MAX = 4096
/** A temporary claim with no end of its own is saved until this many days after it was said. */
export const BRAIN_TEMPORARY_DAYS = 14
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
export {
  BRAIN_LINK_LABEL_MAX,
  BRAIN_LINK_RULES,
  BRAIN_PREDICATE_LABELS,
  BRAIN_PREDICATES,
  BRAIN_SINGLE_VALUED_PREDICATES,
  BRAIN_STRUCTURAL_PREDICATES,
  BRAIN_SYMMETRIC_PREDICATES,
  brainLinkEnded,
  brainLinkSentence,
  brainLinkWords,
} from './brain-links'
export type { BrainLink, BrainPredicate, BrainStatedBy } from './brain-links'
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
  /** Brain Agent checks new knowledge on its own once reads settle; off leaves it to Defrag. */
  agentAuto: boolean
  /** Reader provider/modelId; null uses each lane's own model. Frozen when a job starts. */
  model: string | null
  /** Whole-word title patterns and individually excluded lanes. */
  neverRead: { titles: string[]; sessionIds: string[] }
}
export const DEFAULT_BRAIN_PREFS: BrainPrefs = {
  enabled: false,
  recall: true,
  agentAuto: true,
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
/** One saved memory: a self-contained sentence, the entities it names and the links it states. */
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
  /** When it was saved. */
  recordedAt: number
  /** When a lane last said it: its latest independent citation. Search ranks by its age. */
  observedAt: number
  origin: BrainOrigin | null
  /** 0 low (background detail), 1 normal, 2 high (decisions, owners, commitments, risks). */
  importance: 0 | 1 | 2
  /** 'you' when any lane citation is a message you wrote; else 'agent'. */
  saidBy: 'you' | 'agent'
  /** Distinct lanes among its citations. */
  lanes: number
}
export interface BrainQuote {
  quote: string
  before: string
  after: string
  label: string
}

export type BrainJobStage = 'prepare' | 'extract' | 'identity' | 'reconcile' | 'embed'
export type BrainJobState =
  'waiting' | 'queued' | 'running' | 'empty' | 'failed' | 'done' | 'rejected'
/** One lane read. Up to twenty finished reads per lane retain their leaves and records. */
export interface BrainJob {
  id: string
  /** Earlier finished read of the lane; its unshared memories are replaced when this one saves. */
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
  /** Memories the read saved. */
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
  /** General change counter for explorer and Tidy guards; reads use a knowledge-only guard. */
  revision: number
  /** New after every reset, so views reload even when the revision repeats. */
  generation: string
  counts: { memories: number; entities: number }
  /** The newest 5,000 lane ids with a finished read (done, empty or rejected). */
  readSessionIds: string[]
  /** The inbox: every job that is not done, oldest first. */
  jobs: BrainJob[]
  /** The entity that is you, which the map centres on; null until a read or you say which. */
  ownerId: string | null
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
} from './brain-explore'

export {
  brainLaneNeverRead,
  brainNeverReadReason,
  brainTitleNeverRead,
  checkBrainNeverRead,
  setBrainLaneNeverRead,
} from './brain-never-read'
