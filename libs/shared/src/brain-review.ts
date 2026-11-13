/**
 * Review before saving. A proposal names its entities by job-local refs; the user confirms
 * which existing entity each one is, which memories to keep and which suggested groups hold.
 */
import type {
  BrainEntity,
  BrainEntityKind,
  BrainEpistemicKind,
  BrainJob,
  BrainMemoryType,
  BrainPredicate,
  BrainQuote,
} from './brain'

/** One entity the lane mentions, and what Brain thinks it is. */
export interface BrainIdentity {
  /** Job-local ref; proposed memories and links use it. */
  ref: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
  description: string
  /** `reuse`: it is `entityId`. `uncertain`: the user picks a candidate or new. */
  decision: 'new' | 'reuse' | 'uncertain'
  entityId: string | null
  /** Existing entities it might be, best first. */
  candidates: BrainEntity[]
  reason: string
  /** Decided by an identifier or exact-name rule, without a model call. */
  auto: boolean
}
/** Entities that share a name prefix but no stated parent: "Are these part of one Harbor?" */
export interface BrainGroupQuestion {
  index: number
  /** `entityId` is an existing entity id or an identity ref; null means a new parent. */
  parent: { label: string; kind: BrainEntityKind; entityId: string | null }
  /** Identity refs or existing entity ids. */
  members: string[]
  labels: string[]
}
export interface BrainProposedLink {
  /** Identity ref or existing entity id. */
  subject: string
  predicate: BrainPredicate
  object: string
  quote: string
}
export interface BrainProposedMemory {
  index: number
  summary: string
  type: BrainMemoryType
  kind: BrainEpistemicKind
  /** Identity refs or existing entity ids it names. */
  entities: string[]
  links: BrainProposedLink[]
  branch: boolean
  validFrom: number | null
  validTo: number | null
  /** add: new memory. enrich: adds its links to `target`. The rest change `target`'s state. */
  action: 'add' | 'enrich' | 'supersede' | 'conflict' | 'resolve_open'
  target: { id: string; summary: string } | null
  reason: string
  quotes: BrainQuote[]
}
export interface BrainProposalView {
  job: BrainJob
  revision: number
  identities: BrainIdentity[]
  groups: BrainGroupQuestion[]
  memories: BrainProposedMemory[]
  /** Existing memories this lane says again; saved with any approval. */
  confirmations: { id: string; summary: string }[]
  /** Claims over the per-job budget, held back and listed in the extraction record. */
  held: number
}
/** What the user approves. Null for the whole decision rejects the proposal. */
export interface BrainReviewDecision {
  /** Proposal memory indexes to save. */
  memories: number[]
  /** Overrides by identity ref: an existing entity id, or 'new'. Others keep their decision;
   * an uncertain one without an override becomes new. */
  identities: Record<string, string>
  /** Group question indexes the user confirmed. */
  groups: number[]
}
