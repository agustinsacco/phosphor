import type { BrainLink } from '@shared/brain'
import type { BrainTidyOperation, BrainTidySuggestion } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'
import type { MockAgentJournal } from './mockAgentJournal'

export interface MockDecision {
  kind: BrainTidyOperation['kind']
  summary: string
  reason: string
  apply: (explorer: MockExplorer, journal: MockAgentJournal) => void
}

/** What the mock Brain Agent does with one waiting item, with the reason it records. */
export function decide(item: BrainTidySuggestion, erase: boolean): MockDecision {
  const [first, second] = item.subjects
  if (erase && first?.type === 'memory')
    return {
      kind: 'erase',
      summary: 'Erased a memory: This flag identifies an outdated memory.',
      reason: 'This flag identifies an outdated memory.',
      apply: (_explorer, journal) => journal.erase(first.id),
    }
  if (item.kind === 'unlinked' && item.detail?.kind === 'unlinked' && first && second)
    return relate(first.id, second.id, `${first.label} and ${second.label}`, item.detail.memoryIds)
  if (item.kind === 'group' && item.detail?.kind === 'group') {
    const { parent, memberIds } = item.detail
    return {
      kind: 'group',
      summary: `Grouped ${memberIds.length} under ${parent.label}`,
      reason: 'The read names them as parts of one platform.',
      apply: (explorer) => group(explorer, parent.label, memberIds),
    }
  }
  if (item.kind === 'same_entity' && first && second)
    return {
      kind: 'merge',
      summary: `Merged ${second.label} into ${first.label}`,
      reason: 'Both records describe the same project and evidence.',
      apply: (explorer) => explorer.merge(second.id, first.id),
    }
  return {
    kind: 'keep',
    summary: 'Kept both as they are',
    reason: 'The evidence supports keeping these separate.',
    apply: () => undefined,
  }
}

function relate(subjectId: string, objectId: string, pair: string, memoryIds: string[]) {
  return {
    kind: 'relate' as const,
    summary: `Linked ${pair}: works with`,
    reason: 'Both memories show Tom Lee meeting Northwind about Ledger.',
    apply: (explorer: MockExplorer) => {
      const host = explorer.details.find((d) => d.memory.id === memoryIds[0])
      if (!host) return
      const link: BrainLink = {
        id: `link-agent-${host.memory.id}`,
        subjectId,
        predicate: 'works_with',
        objectId,
        memoryId: host.memory.id,
        label: 'works with',
        validFrom: null,
        validTo: null,
        statedBy: 'agent',
      }
      host.memory.links = [...host.memory.links, link]
    },
  }
}

function group(explorer: MockExplorer, label: string, memberIds: string[]): void {
  const parentId = `group-${label.toLocaleLowerCase().replaceAll(' ', '-')}`
  if (!explorer.entities.some((e) => e.id === parentId))
    explorer.entities.push({ id: parentId, label, kind: 'project', aliases: [], description: '' })
  for (const memberId of memberIds) {
    const host = explorer.details.find((d) => d.memory.entityIds.includes(memberId))
    if (!host) continue
    host.memory.entityIds = [...new Set([...host.memory.entityIds, parentId])]
    host.memory.links = [
      ...host.memory.links,
      {
        id: `link-group-${memberId}`,
        subjectId: memberId,
        predicate: 'part_of',
        objectId: parentId,
        memoryId: host.memory.id,
        label: 'is part of',
        validFrom: null,
        validTo: null,
        statedBy: 'agent',
      },
    ]
  }
}
