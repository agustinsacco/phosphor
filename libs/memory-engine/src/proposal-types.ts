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
  /** Uncertain, with exactly one existing entity of its kind under one of its names. Saved as a
   * new record with a guess for Brain Agent, like any uncertain one. Absent in older proposals. */
  required?: boolean
  /** The reader marked this entity as the person the lane's user is. Absent in older proposals. */
  owner?: true
}
/** Subject and object are job refs or existing entity ids. */
export interface ProposalLink {
  subject: string
  predicate: BrainPredicate
  object: string
  citation: Citation
  /** The reader's wording, read subject to object, at most 80 characters. Readers of proposals
   * stored before v8 fill ''. */
  label: string
  /** When the relationship started and ended, if the lane said. Absent in older proposals. */
  validFrom?: number | null
  validTo?: number | null
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
  /** `temporary` saves with an end BRAIN_TEMPORARY_DAYS after it was said, unless it has one;
   * `personal` is never saved. Absent in older proposals. */
  hold?: 'temporary' | 'personal' | null
  /** 0 low, 1 normal, 2 high, as the reader judged it. Absent in older proposals: 1. */
  importance?: 0 | 1 | 2
}
/** "Are these part of one parent?" Members are job refs or existing entity ids. */
export interface ProposalGroup {
  /** `entityId` is an existing entity id or a job entity ref; null creates the parent. */
  parent: { label: string; kind: BrainEntityKind; entityId: string | null }
  members: string[]
}
/** Everything one read found, with vectors, ready to save. */
export interface Proposal {
  jobId: string
  origin: BrainOrigin
  scope: string
  branch: string | null
  /** Knowledge revision the candidates and reconciliation were computed against. `saveRead`
   * refuses with BRAIN_READ_STALE when it moved. */
  computedRevision: number
  entities: ProposalEntity[]
  memories: ProposalMemory[]
  groups: ProposalGroup[]
  /** Existing memories this lane says again, with the fresh quotes. */
  confirmations: {
    memoryId: string
    /** Original claim, retained so an identity override can save it as a new memory. */
    claim: ProposalMemory
    vector: Float32Array
  }[]
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
  /** The claim's embedding. Matches are scored against it; without it they score 0. */
  vector?: Float32Array
}
/** An existing memory that may say the same thing as a claim, and how it was found. */
export interface MemoryMatch {
  id: string
  /** `link`: it states the claim's link, or owns the claim's owned thing. `entity`: it names
   * one of the claim's entities. `replaced`: a superseded memory naming one of them, at cosine
   * 0.85 or more, so a claim that only repeats it can be dropped. */
  channel: 'link' | 'entity' | 'replaced'
  /** Cosine similarity to the probe's vector; 0 without one. */
  similarity: number
}
export type MemoryCard = BrainMemory
