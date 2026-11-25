import type { BrainTidyKind, BrainTidySuggestion } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'

const CYCLE: BrainTidyKind[] = ['same_entity', 'same_memory', 'conflict', 'flagged']

/**
 * Made-up suggestions: an unlinked pair (Tom Lee and Northwind are named together twice), a
 * read's group question, then same-name people, repeats, disagreements and a flag, in turn.
 */
export function seedMockTidy(
  explorer: MockExplorer,
  count: number,
  now: number,
): BrainTidySuggestion[] {
  if (count < 1) return []
  const base = { state: 'open' as const, verdict: null, model: null, flag: null }
  const fixed: BrainTidySuggestion[] = [
    {
      ...base,
      id: 'tidy-unlinked',
      kind: 'unlinked',
      source: 'sweep',
      subjects: [
        { type: 'entity', id: 'tom', label: 'Tom Lee' },
        { type: 'entity', id: 'northwind', label: 'Northwind' },
      ],
      reason: 'Named together in 2 memories; no link says how they relate.',
      detail: { kind: 'unlinked', shared: 2, memoryIds: ['memory-12', 'memory-11'] },
      createdAt: now,
      updatedAt: now,
    },
    {
      ...base,
      id: 'tidy-group',
      kind: 'group',
      source: 'read',
      subjects: [
        { type: 'entity', id: 'component-0', label: 'Harbor component 1' },
        { type: 'entity', id: 'component-1', label: 'Harbor component 2' },
      ],
      reason: 'A read asked whether these are part of Harbor billing platform.',
      detail: {
        kind: 'group',
        jobId: 'harbor-job',
        parent: { label: 'Harbor billing platform', kind: 'project', entityId: null },
        memberIds: ['component-0', 'component-1'],
      },
      createdAt: now,
      updatedAt: now,
    },
  ]
  const cycled = Array.from({ length: Math.max(0, count - fixed.length) }, (_, index) =>
    cycledSuggestion(explorer, index, now),
  )
  return [...fixed.slice(0, count), ...cycled]
}

function cycledSuggestion(explorer: MockExplorer, index: number, now: number): BrainTidySuggestion {
  const kind = CYCLE[index % CYCLE.length]!
  const id = `tidy-${index}`
  const subjects: BrainTidySuggestion['subjects'] = []
  if (kind === 'same_entity') {
    for (let side = 0; side < 2; side++) {
      const entity = {
        ...structuredClone(explorer.entities.find((e) => e.id === 'rina')!),
        id: `${id}-${side}`,
        label: side ? 'Rina' : 'Rina Okafor',
        description: side
          ? 'Harbor migration lead, mentioned in Kestrel planning.'
          : 'Ledger migration owner.',
      }
      explorer.entities.push(entity)
      const detail = structuredClone(explorer.details[1]!)
      detail.memory.id = `${entity.id}-memory`
      detail.memory.entityIds = [entity.id]
      detail.memory.links = []
      explorer.details.push(detail)
      subjects.push({ type: 'entity', id: entity.id, label: entity.label })
    }
  } else {
    for (let side = 0; side < (kind === 'flagged' ? 1 : 2); side++) {
      const detail = structuredClone(explorer.details[0]!)
      detail.memory.id = `${id}-${side}`
      detail.memory.summary =
        kind === 'conflict'
          ? `Ledger invoices are sent ${side ? 'monthly' : 'weekly'}.`
          : `Ledger keeps migration receipts${side ? ' for each release' : ''}.`
      detail.memory.links = []
      detail.quotes = [
        { before: '', quote: detail.memory.summary, after: '', label: 'You · Ledger planning' },
      ]
      explorer.details.push(detail)
      subjects.push({ type: 'memory', id: detail.memory.id, label: detail.memory.summary })
    }
  }
  // Every second people pair was checked: the model thinks they differ, and it stays open.
  const different = kind === 'same_entity' && index % 8 === 4
  return {
    id,
    kind,
    subjects,
    source: kind === 'flagged' ? 'flag' : kind === 'conflict' || different ? 'check' : 'sweep',
    state: 'open',
    reason:
      kind === 'flagged'
        ? 'The lane verified that receipts are no longer retained.'
        : kind === 'conflict'
          ? 'The invoice schedules disagree.'
          : 'These records share a name or assertion.',
    verdict:
      kind === 'conflict'
        ? { kind: 'conflict', reason: 'The invoice schedules disagree.' }
        : different
          ? { kind: 'different', reason: 'Only the name matches; the descriptions differ.' }
          : null,
    model: null,
    flag:
      kind === 'flagged'
        ? { problem: 'outdated', sessionId: 'harbor-lane', title: 'Harbor planning' }
        : null,
    detail: null,
    createdAt: now,
    updatedAt: now,
  }
}
