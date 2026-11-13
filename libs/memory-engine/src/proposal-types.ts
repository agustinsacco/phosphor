import type {
  BrainEntity,
  BrainEntityKind,
  BrainEpistemicKind,
  BrainMemory,
  BrainMemoryType,
  BrainOrigin,
  BrainPredicate,
  BrainSourceSegment,
} from '@phosphor/shared/brain'

/** One readable piece of a lane transcript: a message, tool output, tool call or summary. */
export type TranscriptSegment = BrainSourceSegment

/** Sanitized transcript text kept around cited quotes, so memories outlive their lane. */
export interface EvidenceExcerpt {
  sessionId: string
  entryId: string
  role: TranscriptSegment['role']
  label: string
  observedAt: number
  text: string
}
/** A verified quote: `evidence` indexes the proposal's evidence list. */
export interface Citation {
  evidence: number
  quote: string
}
/** A stable identifier that resolves an entity without a model, e.g. ('github:org/repo#pr', '27'). */
export interface EntityKey {
  namespace: string
  value: string
}

/** One entity a job found, and what the pipeline decided it is. */
export interface ProposalEntity {
  /** Job-local ref; memories, links and groups use it. */
  ref: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
  description: string
  keys: EntityKey[]
  decision: 'new' | 'reuse' | 'uncertain'
  /** The existing entity for `reuse`. */
  entityId: string | null
  /** Existing entity ids offered as candidates, best first. */
  candidates: string[]
  reason: string
  auto: boolean
}
/** Subject and object are job refs or existing entity ids. */
export interface ProposalLink {
  subject: string
  predicate: BrainPredicate
  object: string
  citation: Citation
}
export interface ProposalMemory {
  summary: string
  type: BrainMemoryType
  kind: BrainEpistemicKind
  /** Job refs or existing entity ids it names. */
  entities: string[]
  links: ProposalLink[]
  branch: boolean
  validFrom: number | null
  validTo: number | null
  citations: Citation[]
  /** What to do with `target`, an existing memory id; `add` has none. */
  action: 'add' | 'enrich' | 'supersede' | 'conflict' | 'resolve_open'
  target: string | null
  reason: string
}
/** "Are these part of one parent?" Members are job refs or existing entity ids. */
export interface ProposalGroup {
  /** `entityId` is an existing entity id or a job entity ref; null creates the parent. */
  parent: { label: string; kind: BrainEntityKind; entityId: string | null }
  members: string[]
}
/** Everything one job proposes, with vectors, ready for review. */
export interface Proposal {
  jobId: string
  origin: BrainOrigin
  scope: string
  branch: string | null
  /** Store revision the candidates and reconciliation were computed against. */
  computedRevision: number
  entities: ProposalEntity[]
  memories: ProposalMemory[]
  groups: ProposalGroup[]
  /** Existing memories this lane says again, with the fresh quotes. */
  confirmations: { memoryId: string; citations: Citation[] }[]
  evidence: EvidenceExcerpt[]
  /** Claims over the per-job budget, not proposed. */
  held: number
  /** One per memory, in order. */
  memoryVectors: Float32Array[]
  /** One per entity, in order: label, kind and description. */
  entityVectors: Float32Array[]
}
export interface ProposalResult {
  memories: number
  confirmations: number
  identities: number
}

/** An existing entity as a resolver or reconciler sees it. */
export interface EntityCard extends BrainEntity {
  /** Up to three labels it links to, for context. */
  neighbours: string[]
  memories: number
}
/** A candidate from the store's exact and lexical channels. */
export interface EntityMatch {
  entityId: string
  channel: 'key' | 'name' | 'words' | 'trigram'
  score: number
}
/** Where to look for old memories that may say the same thing as a new claim. */
export interface ClaimProbe {
  entityIds: string[]
  links: { subjectId: string; predicate: BrainPredicate; objectId: string }[]
}
export type MemoryCard = BrainMemory
