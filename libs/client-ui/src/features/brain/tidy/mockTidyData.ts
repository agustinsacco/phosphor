import {
  BRAIN_TIDY_KINDS,
  type BrainTidySuggestion,
  type BrainTidySubjectDetail,
  type BrainTidyAction,
} from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'

/** Made-up pairs with separate records, including same-name people in different lanes. */
export function seedMockTidy(
  explorer: MockExplorer,
  count: number,
  now: number,
): BrainTidySuggestion[] {
  return Array.from({ length: count }, (_, index) => {
    const kind = BRAIN_TIDY_KINDS[index % 4]!
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
            ? `Harbor Ledger invoices are sent ${side ? 'monthly' : 'weekly'}.`
            : `Harbor Ledger keeps migration receipts${side ? ' for each release' : ''}.`
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
      model: kind === 'conflict' || different ? 'demo/harbor-model' : null,
      flag:
        kind === 'flagged'
          ? { problem: 'outdated', sessionId: 'harbor-lane', title: 'Harbor planning' }
          : null,
      createdAt: now,
      updatedAt: now,
    }
  })
}

export function mockTidyPermissions(
  suggestion: BrainTidySuggestion,
  subjects: BrainTidySubjectDetail[],
): {
  allowed: BrainTidyAction['kind'][]
  foldRefusal: 'applicability' | 'history' | null
} {
  const none = { allowed: [], foldRefusal: null }
  if (suggestion.state !== 'open' || subjects.length !== suggestion.subjects.length) return none
  if (suggestion.kind === 'flagged') return { allowed: ['forget', 'keep'], foldRefusal: null }
  const [a, b] = subjects
  if (a?.type === 'entity' && b?.type === 'entity') return { allowed: ['merge'], foldRefusal: null }
  if (a?.type !== 'memory' || b?.type !== 'memory') return none
  const fields = ['scope', 'branch', 'validFrom', 'validTo'] as const
  const foldRefusal = fields.some((field) => a.value.memory[field] !== b.value.memory[field])
    ? 'applicability'
    : [a.value, b.value].some(
          (d) => d.history.length || d.related.length || d.memory.state !== 'active',
        )
      ? 'history'
      : null
  return {
    allowed: foldRefusal ? ['dispute', 'replace'] : ['fold', 'dispute', 'replace'],
    foldRefusal,
  }
}
