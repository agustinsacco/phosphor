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
  /** Held confirmation indexes the owner ticked; the others apply without a tick. */
  confirmations: number[]
}

/** Claims Brain holds back until the owner ticks them. */
export function holdOf(memory: Pick<BrainProposedMemory, 'hold'>): ReviewHold | null {
  return memory.hold
}

/** Confirmations that apply with any approval, so they fold into one line. */
export function plainConfirmations(
  proposal: BrainProposalView,
): BrainProposalView['confirmations'] {
  return proposal.confirmations.filter((item) => !holdOf(item.claim))
}

/**
 * One checklist row: a proposed memory (ticked by its memory index) or a held confirmation
 * (ticked by its confirmation index), which says the same as a stored memory.
 */
export interface ChecklistItem {
  key: string
  claim: Omit<BrainProposedMemory, 'index'>
  kind: 'memory' | 'confirmation'
  index: number
  /** What saving it does to an existing memory, in a few words. */
  change: string | null
}
function memoryItem(memory: BrainProposedMemory): ChecklistItem {
  const { index, ...claim } = memory
  return { key: `memory-${index}`, claim, kind: 'memory', index, change: memoryChange(memory) }
}
function heldConfirmationItems(proposal: BrainProposalView): ChecklistItem[] {
  return proposal.confirmations.flatMap((item, index) =>
    holdOf(item.claim)
      ? [
          {
            key: `confirmation-${index}`,
            claim: item.claim,
            kind: 'confirmation' as const,
            index,
            change: `Confirms “${item.summary}”`,
          },
        ]
      : [],
  )
}
/** Rows the owner ticks: every proposed memory and every held confirmation. */
export function checklistTotal(proposal: BrainProposalView): number {
  return proposal.memories.length + heldConfirmationItems(proposal).length
}
export function tickCount(choices: ReviewChoices): number {
  return choices.keep.length + choices.confirmations.length
}
export function isTicked(choices: ReviewChoices, item: ChecklistItem): boolean {
  return (item.kind === 'memory' ? choices.keep : choices.confirmations).includes(item.index)
}
/** Ticks or unticks every given row, memories and held confirmations alike. */
export function setTicked(
  choices: ReviewChoices,
  items: ChecklistItem[],
  ticked: boolean,
): ReviewChoices {
  const apply = (kind: ChecklistItem['kind'], old: number[]): number[] => {
    const indexes = items.filter((item) => item.kind === kind).map((item) => item.index)
    return ticked
      ? [...new Set([...old, ...indexes])]
      : old.filter((index) => !indexes.includes(index))
  }
  return {
    ...choices,
    keep: apply('memory', choices.keep),
    confirmations: apply('confirmation', choices.confirmations),
  }
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
    confirmations: [],
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
  items: ChecklistItem[]
}
/** Plain memories by type, then the held groups, which also hold held confirmations. */
export function checklistGroups(proposal: BrainProposalView): ChecklistGroup[] {
  const items = [...proposal.memories.map(memoryItem), ...heldConfirmationItems(proposal)]
  const plain = REVIEW_TYPE_ORDER.map((type): ChecklistGroup => ({
    id: type,
    label: MEMORY_LABELS[type],
    held: false,
    items: items.filter((item) => !holdOf(item.claim) && item.claim.type === type),
  }))
  const held = (['temporary', 'personal'] as const).map((hold): ChecklistGroup => ({
    id: hold,
    label: HOLD_LABELS[hold],
    held: true,
    items: items.filter((item) => holdOf(item.claim) === hold),
  }))
  return [...plain, ...held].filter((group) => group.items.length > 0)
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
    confirmations: choices.confirmations.toSorted((a, b) => a - b),
  }
}

/** Counts ticked rows, held confirmations included. */
export function approveLabel(proposal: BrainProposalView, ticked: number): string {
  const total = checklistTotal(proposal)
  if (!total && proposal.confirmations.length) return 'Approve confirmations'
  return ticked < total ? `Approve ${ticked} of ${total}` : `Approve ${ticked}`
}

/** Why Approve is off, or null when it can be pressed. */
export function approveBlock(proposal: BrainProposalView, choices: ReviewChoices): string | null {
  const open = openQuestions(proposal, choices.identities).length
  if (open) return `Answer ${formatCount(open, 'question')}`
  // Confirmations that are not held apply without a tick; held ones are checklist rows.
  const confirmationsOnly = !checklistTotal(proposal) && plainConfirmations(proposal).length > 0
  if (!proposal.job.replaces && !tickCount(choices) && !confirmationsOnly && !choices.groups.length)
    return 'Tick a memory to approve'
  return null
}

/** What a proposed memory does to an existing one, in a few words. */
export function memoryChange(
  memory: Pick<BrainProposedMemory, 'action' | 'target'>,
): string | null {
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

export function memoryNames(
  proposal: BrainProposalView,
  memory: Pick<BrainProposedMemory, 'entities'>,
): string[] {
  return memory.entities.flatMap((ref) => refLabel(proposal, ref) ?? [])
}
