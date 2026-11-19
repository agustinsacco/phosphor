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

/**
 * The review is being recomputed because knowledge changed since it was read. The page shows
 * it as refreshing and loads it again; it is the only load or approval refusal that does.
 */
export const BRAIN_REVIEW_REFRESHING = 'Brain changed; refreshing this review'
/** Knowledge changed between opening a review and approving it: the page reloads it. */
export const BRAIN_REVIEW_CHANGED = 'Brain changed while you were reviewing. Reopen the review.'
/** A stale review of a lane Brain is set never to read: it cannot refresh, only be rejected. */
export const BRAIN_NEVER_READ_REFRESH_REFUSAL =
  "Brain changed since this was read, and this lane is set to never be read, so it can't be refreshed. Reject it instead."

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
  /** An unsure exact-name match requires a choice before approval. */
  required: boolean
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
  /** Temporary or personal claims are saved only when explicitly selected. */
  hold: 'temporary' | 'personal' | null
}
export interface BrainProposalView {
  job: BrainJob
  revision: number
  /** Existing lane memories an approval will remove; zero for an ordinary read. */
  replacingMemories: number
  identities: BrainIdentity[]
  groups: BrainGroupQuestion[]
  memories: BrainProposedMemory[]
  /** Saved with any approval, except held ones, which wait for a tick (`decision.confirmations`).
   * Identity overrides turn dependent claims into new memories. */
  confirmations: { id: string; summary: string; claim: Omit<BrainProposedMemory, 'index'> }[]
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
  /** Identity refs whose read description replaces the stored description. */
  descriptions: string[]
  /** Indexes into the proposal's `confirmations` the owner ticked. Only held ones may be listed:
   * a held confirmation changes nothing unless it is here; the others apply with any approval. */
  confirmations: number[]
}

/** How Desktop and the engine refuse a review decision, word for word. */
export const BRAIN_DECISION_REFUSALS = {
  /** Malformed or oversized input, refused before any proposal is read. */
  selection: 'Invalid review selection.',
  index: 'Brain proposal index is invalid.',
  identity: 'Brain identity override is invalid.',
  description: 'Brain description choice is invalid.',
  confirmation: 'Brain confirmation choice is invalid.',
} as const
/** Approval that would save something naming an unanswered required identity. */
export function brainRequiredAnswerRefusal(label: string): string {
  return `Say whether “${label}” is someone Brain already knows or someone new before approving.`
}

/** A proposal holds at most 300 memories and confirmations together. */
const CONFIRMATIONS = 300
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const refuse = (message: string): never => {
  throw new Error(message)
}
const indexes = (value: unknown, max: number, message: string): number[] =>
  Array.isArray(value) &&
  value.length <= max &&
  new Set(value).size === value.length &&
  value.every((index) => Number.isInteger(index) && index >= 0 && index < max)
    ? (value as number[])
    : refuse(message)

/**
 * The decision's shape and sizes, checked before any proposal is read: exactly these keys,
 * unique integer indexes, at most 400 memories, 100 groups, 300 confirmations, and 400
 * identity answers and descriptions with refs of at most 64 characters. Null rejects.
 */
export function checkBrainReviewDecision(value: unknown): BrainReviewDecision | null {
  const { selection, confirmation } = BRAIN_DECISION_REFUSALS
  if (value === null) return null
  const keys = ['memories', 'identities', 'groups', 'descriptions', 'confirmations']
  if (!record(value) || !Object.keys(value).every((key) => keys.includes(key)))
    return refuse(selection)
  const identities = value.identities
  if (
    !record(identities) ||
    Object.keys(identities).length > 400 ||
    Object.entries(identities).some(
      ([ref, choice]) =>
        ref.length > 64 || typeof choice !== 'string' || !choice || choice.length > 200,
    )
  )
    refuse(selection)
  if (
    !Array.isArray(value.descriptions) ||
    value.descriptions.length > 400 ||
    Array.from(value.descriptions).some((ref) => typeof ref !== 'string' || !ref || ref.length > 64)
  )
    refuse(selection)
  return {
    descriptions: value.descriptions as string[],
    memories: indexes(value.memories, 400, selection),
    identities: identities as Record<string, string>,
    groups: indexes(value.groups, 100, selection),
    confirmations: indexes(value.confirmations, CONFIRMATIONS, confirmation),
  }
}
