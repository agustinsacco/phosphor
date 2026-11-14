import type { BrainMemoryDetail, BrainProposalView, BrainReviewDecision } from '@shared/brain'
import { mockBrainData } from './mockBrainData'
import type { MockExplorer } from './mockExplorer'

/** The browser's invented review applies the same explicit choices as the Desktop form. */
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
    const detail = structuredClone(sample.details[index]!)
    detail.memory.id = `${proposal.job.id}-${index}`
    detail.memory.jobId = proposal.job.id
    detail.memory.origin = { sessionId: proposal.job.sessionId, title: proposal.job.title }
    detail.memory.entityIds = detail.memory.entityIds.map(resolve)
    detail.memory.links = detail.memory.links.map((link) => ({
      ...link,
      id: `${proposal.job.id}-${link.id}`,
      memoryId: detail.memory.id,
      subjectId: resolve(link.subjectId),
      objectId: resolve(link.objectId),
    }))
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
