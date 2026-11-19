import type {
  BrainEntity,
  BrainIdentity,
  BrainMemoryType,
  BrainProposalView,
  BrainProposedMemory,
  BrainReviewDecision,
} from '@shared/brain'
import { formatCount } from '@/lib/format'
import { MEMORY_LABELS } from '../memoryLabels'

/** The order a reviewer reads a read in: what was decided and what can go wrong first. */
export const REVIEW_TYPE_ORDER: readonly BrainMemoryType[] = [
  'decision',
  'risk',
  'fact',
  'open',
  'procedure',
  'preference',
]
export type ReviewHold = 'temporary' | 'personal'
export const HOLD_LABELS: Record<ReviewHold, string> = {
  temporary: 'Probably temporary',
  personal: 'About a person',
}

export interface ReviewChoices {
  /** Proposal memory indexes to save. */
  keep: number[]
  /** Identity ref → existing entity id or 'new'. */
  identities: Record<string, string>
  groups: number[]
  /** Identity refs whose description from this read replaces the stored one. */
  descriptions: string[]
}

/** Claims Brain holds back until the owner ticks them. */
export function holdOf(memory: BrainProposedMemory): ReviewHold | null {
  return memory.hold
}

/** An unsure identity whose exact name Brain already knows: approval waits for an answer. */
export function isRequired(identity: BrainIdentity): boolean {
  return identity.required
}

export function initialChoices(proposal: BrainProposalView): ReviewChoices {
  return {
    keep: proposal.memories.filter((memory) => !holdOf(memory)).map((memory) => memory.index),
    identities: {},
    groups: [],
    descriptions: [],
  }
}

/** Asked as questions: required ones first, then every other choice Brain is not sure of. */
export function questionIdentities(proposal: BrainProposalView): BrainIdentity[] {
  const asked = proposal.identities.filter(
    (identity) => isRequired(identity) || (!identity.auto && identity.candidates.length > 0),
  )
  return [...asked.filter(isRequired), ...asked.filter((identity) => !isRequired(identity))]
}

/** Matched by a rule or plainly new: folded into one line. */
export function foldedIdentities(proposal: BrainProposalView): BrainIdentity[] {
  const asked = new Set(questionIdentities(proposal))
  return proposal.identities.filter((identity) => !asked.has(identity))
}

/** The answer in force: the owner's, else Brain's suggestion, else none for a required one. */
export function identityChoice(
  identity: BrainIdentity,
  choices: Record<string, string>,
): string | null {
  const chosen = choices[identity.ref]
  if (chosen) return chosen
  if (isRequired(identity)) return null
  return identity.decision === 'reuse' && identity.entityId ? identity.entityId : 'new'
}

export function openQuestions(
  proposal: BrainProposalView,
  choices: Record<string, string>,
): BrainIdentity[] {
  return proposal.identities.filter((identity) => isRequired(identity) && !choices[identity.ref])
}

export function chosenEntity(
  identity: BrainIdentity,
  choices: Record<string, string>,
): BrainEntity | null {
  const id = identityChoice(identity, choices)
  return identity.candidates.find((candidate) => candidate.id === id) ?? null
}

const same = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** The existing record this identity becomes, when this read describes it differently. */
export function differingDescription(
  identity: BrainIdentity,
  choices: Record<string, string>,
): BrainEntity | null {
  const existing = chosenEntity(identity, choices)
  return existing &&
    identity.description.trim() &&
    !same(existing.description, identity.description)
    ? existing
    : null
}

export interface ChecklistGroup {
  id: BrainMemoryType | ReviewHold
  label: string
  held: boolean
  memories: BrainProposedMemory[]
}
export function checklistGroups(proposal: BrainProposalView): ChecklistGroup[] {
  const plain = REVIEW_TYPE_ORDER.map((type): ChecklistGroup => ({
    id: type,
    label: MEMORY_LABELS[type],
    held: false,
    memories: proposal.memories.filter((m) => !holdOf(m) && m.type === type),
  }))
  const held = (['temporary', 'personal'] as const).map((hold): ChecklistGroup => ({
    id: hold,
    label: HOLD_LABELS[hold],
    held: true,
    memories: proposal.memories.filter((m) => holdOf(m) === hold),
  }))
  return [...plain, ...held].filter((group) => group.memories.length > 0)
}

/**
 * Only answered or changed identities are sent. A ticked description goes only while its
 * identity still becomes an existing record that is described differently, so switching to
 * Someone new drops it.
 */
export function reviewDecision(
  proposal: BrainProposalView,
  choices: ReviewChoices,
): BrainReviewDecision {
  return {
    descriptions: choices.descriptions.filter((ref) => {
      const identity = proposal.identities.find((item) => item.ref === ref)
      return !!identity && differingDescription(identity, choices.identities) !== null
    }),
    memories: choices.keep.toSorted((a, b) => a - b),
    identities: { ...choices.identities },
    groups: choices.groups.toSorted((a, b) => a - b),
    confirmations: [],
  }
}

export function approveLabel(proposal: BrainProposalView, keep: number): string {
  if (!proposal.memories.length && proposal.confirmations.length) return 'Approve confirmations'
  const total = proposal.memories.length
  return keep < total ? `Approve ${keep} of ${total}` : `Approve ${keep}`
}

/** Why Approve is off, or null when it can be pressed. */
export function approveBlock(proposal: BrainProposalView, choices: ReviewChoices): string | null {
  const open = openQuestions(proposal, choices.identities).length
  if (open) return `Answer ${formatCount(open, 'question')}`
  const confirmationsOnly = !proposal.memories.length && proposal.confirmations.length > 0
  if (
    !proposal.job.replaces &&
    !choices.keep.length &&
    !confirmationsOnly &&
    !choices.groups.length
  )
    return 'Tick a memory to approve'
  return null
}

/** What a proposed memory does to an existing one, in a few words. */
export function memoryChange(memory: BrainProposedMemory): string | null {
  if (!memory.target) return null
  switch (memory.action) {
    case 'enrich':
      return `Adds links to “${memory.target.summary}”`
    case 'supersede':
      return `Replaces “${memory.target.summary}”`
    case 'conflict':
      return `Disagrees with “${memory.target.summary}”`
    case 'resolve_open':
      return `Answers “${memory.target.summary}”`
    default:
      return null
  }
}

/** A proposal names entities by identity ref or by an existing entity's id. */
export function refLabel(proposal: BrainProposalView, ref: string): string | null {
  const identity = proposal.identities.find((item) => item.ref === ref)
  if (identity) return identity.label
  for (const item of proposal.identities)
    for (const candidate of item.candidates) if (candidate.id === ref) return candidate.label
  return null
}

export function memoryNames(proposal: BrainProposalView, memory: BrainProposedMemory): string[] {
  return memory.entities.flatMap((ref) => refLabel(proposal, ref) ?? [])
}
