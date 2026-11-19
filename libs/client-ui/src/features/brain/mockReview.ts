import type {
  BrainMemoryDetail,
  BrainProposalView,
  BrainProposedMemory,
  BrainReviewDecision,
} from '@shared/brain'
import {
  BRAIN_DECISION_REFUSALS,
  brainRequiredAnswerRefusal,
  checkBrainReviewDecision,
} from '@shared/brain-review'
import { mockBrainData } from './mockBrainData'
import type { MockExplorer } from './mockExplorer'

type Claim = Pick<BrainProposedMemory, 'entities' | 'links'>
const claimRefs = (claim: Claim): string[] => [
  ...claim.entities,
  ...claim.links.flatMap((link) => [link.subject, link.object]),
]
/** The owner answered one of the claim's identities differently from Brain's suggestion. */
function identityChanged(
  proposal: BrainProposalView,
  decision: BrainReviewDecision,
  claim: Claim,
): boolean {
  return claimRefs(claim).some((ref) => {
    const override = decision.identities[ref]
    const identity = proposal.identities.find((item) => item.ref === ref)
    return (
      override !== undefined &&
      override !== (identity?.decision === 'reuse' ? identity.entityId : 'new')
    )
  })
}
/** Every ref this approval resolves: ticked memories, confirmed groups, and confirmations
 * (not held, or ticked) that become new memories because an identity changed. */
function usedRefs(proposal: BrainProposalView, decision: BrainReviewDecision): Set<string> {
  const memories = proposal.memories.filter((memory) => decision.memories.includes(memory.index))
  const groups = proposal.groups.filter((group) => decision.groups.includes(group.index))
  const confirmations = proposal.confirmations.filter(
    (item, index) =>
      (!item.claim.hold || decision.confirmations.includes(index)) &&
      identityChanged(proposal, decision, item.claim),
  )
  return new Set([
    ...memories.flatMap(claimRefs),
    ...groups.flatMap((group) => [
      ...group.members,
      ...(group.parent.entityId ? [group.parent.entityId] : []),
    ]),
    ...confirmations.flatMap((item) => claimRefs(item.claim)),
  ])
}

/**
 * Refuses what Desktop refuses, in its words, before anything changes: the shape and sizes its
 * IPC check accepts, then the engine's rules in the engine's order (indexes, identity answers,
 * descriptions, held-only confirmation ticks, required answers). `known` says whether an
 * existing record id is in the mock's Brain.
 */
export function checkMockDecision(
  proposal: BrainProposalView,
  value: unknown,
  known: (entityId: string) => boolean,
): BrainReviewDecision | null {
  const decision = checkBrainReviewDecision(value)
  if (!decision) return null
  const { index, identity, description, confirmation } = BRAIN_DECISION_REFUSALS
  const refuse = (message: string): never => {
    throw new Error(message)
  }
  if (
    decision.memories.some((i) => !proposal.memories.some((memory) => memory.index === i)) ||
    decision.groups.some((i) => !proposal.groups.some((group) => group.index === i))
  )
    refuse(index)
  for (const [ref, target] of Object.entries(decision.identities))
    if (
      !proposal.identities.some((item) => item.ref === ref) ||
      (target !== 'new' && !known(target))
    )
      refuse(identity)
  for (const ref of decision.descriptions)
    if (!proposal.identities.find((item) => item.ref === ref)?.description.trim())
      refuse(description)
  if (decision.confirmations.some((i) => !proposal.confirmations[i]?.claim.hold))
    refuse(confirmation)
  const used = usedRefs(proposal, decision)
  const unanswered = proposal.identities.find(
    (item) => item.required && used.has(item.ref) && !(item.ref in decision.identities),
  )
  if (unanswered) refuse(brainRequiredAnswerRefusal(unanswered.label))
  return decision
}

/**
 * The browser's invented review applies the same explicit choices as the Desktop form. The
 * caller checks the decision first (checkMockDecision), before anything changes.
 */
export function applyMockReview(
  explorer: MockExplorer,
  proposal: BrainProposalView,
  decision: BrainReviewDecision,
): void {
  const sample = mockBrainData()
  const ids = new Map<string, string>()
  const resolve = (ref: string): string => {
    const old = ids.get(ref)
    if (old) return old
    const identity = proposal.identities.find((i) => i.ref === ref)
    const override = decision.identities[ref]
    const isNew = override === 'new' || (!override && identity && identity.decision !== 'reuse')
    const id = isNew ? `${proposal.job.id}-${ref}` : (override ?? identity?.entityId ?? ref)
    if (!explorer.entities.some((e) => e.id === id)) {
      const source = sample.entities.find((e) => e.id === ref)
      if (!source) throw new Error('Unknown identity')
      explorer.entities.push({ ...source, id })
    }
    ids.set(ref, id)
    return id
  }
  for (const index of decision.memories) {
    const proposed = proposal.memories.find((m) => m.index === index)
    if (!proposed) throw new Error('Invalid memory selection')
    // Saved in the proposal's own words, on an invented sample's dates and scope.
    const detail = structuredClone(sample.details[index] ?? sample.details[0]!)
    const id = `${proposal.job.id}-${index}`
    detail.memory = {
      ...detail.memory,
      id,
      jobId: proposal.job.id,
      origin: { sessionId: proposal.job.sessionId, title: proposal.job.title },
      summary: proposed.summary,
      type: proposed.type,
      kind: proposed.kind,
      entityIds: proposed.entities.map(resolve),
      links: proposed.links.map((link, at) => ({
        id: `${id}-link-${at}`,
        memoryId: id,
        subjectId: resolve(link.subject),
        objectId: resolve(link.object),
        predicate: link.predicate,
      })),
    }
    detail.quotes = proposed.quotes
    detail.linkQuotes = Object.fromEntries(
      detail.memory.links.map((link) => [link.id, detail.quotes]),
    )
    const target =
      proposed.target && explorer.details.find((d) => d.memory.id === proposed.target!.id)
    if (
      proposed.action === 'enrich' &&
      target &&
      proposed.entities.every((ref) => resolve(ref) === ref)
    )
      enrich(target, detail)
    else explorer.details.push(detail)
  }
  applyGroups(explorer, proposal, decision.groups, resolve)
  for (const ref of decision.descriptions) {
    const identity = proposal.identities.find((item) => item.ref === ref)!
    const entity = explorer.entities.find((item) => item.id === resolve(ref))
    if (entity) entity.description = identity.description
  }
}

function applyGroups(
  explorer: MockExplorer,
  proposal: BrainProposalView,
  selected: number[],
  resolve: (ref: string) => string,
): void {
  const sample = mockBrainData()
  for (const index of selected) {
    const group = proposal.groups.find((g) => g.index === index)
    if (!group) throw new Error('Invalid group selection')
    const parent = group.parent.entityId ?? `group-${proposal.job.id}-${index}`
    if (!explorer.entities.some((e) => e.id === parent))
      explorer.entities.push({
        id: parent,
        label: group.parent.label,
        kind: group.parent.kind,
        aliases: [],
        description: 'Stated by you in review',
      })
    for (const member of group.members) {
      const subject = resolve(member)
      if (subject === parent) continue
      const detail = structuredClone(sample.details[0]!)
      const id = `${proposal.job.id}-group-${index}-${subject}`
      detail.memory = {
        ...detail.memory,
        id,
        jobId: proposal.job.id,
        type: 'fact',
        summary: `${explorer.entities.find((e) => e.id === subject)!.label} is part of ${group.parent.label}.`,
        entityIds: [subject, parent],
        links: [
          {
            id: `link-${id}`,
            memoryId: id,
            subjectId: subject,
            objectId: parent,
            predicate: 'part_of',
          },
        ],
      }
      detail.quotes = [
        { quote: detail.memory.summary, before: '', after: '', label: 'Stated by you in review' },
      ]
      detail.linkQuotes = { [`link-${id}`]: detail.quotes }
      explorer.details.push(detail)
    }
  }
}

function enrich(target: BrainMemoryDetail, detail: BrainMemoryDetail): void {
  for (const link of detail.memory.links)
    if (
      !target.memory.links.some(
        (l) =>
          l.subjectId === link.subjectId &&
          l.objectId === link.objectId &&
          l.predicate === link.predicate,
      )
    ) {
      target.memory.links.push({ ...link, memoryId: target.memory.id })
      target.linkQuotes[link.id] = detail.quotes
    }
  target.memory.entityIds = [...new Set([...target.memory.entityIds, ...detail.memory.entityIds])]
}
