import { expect, it } from 'vitest'
import {
  BRAIN_LINK_LABEL_MAX,
  BRAIN_LINK_RULES,
  BRAIN_PREDICATE_LABELS,
  BRAIN_PREDICATES,
  BRAIN_SINGLE_VALUED_PREDICATES,
  BRAIN_STRUCTURAL_PREDICATES,
  BRAIN_SYMMETRIC_PREDICATES,
  brainLinkEnded,
  brainLinkSentence,
  brainLinkWords,
  type BrainLink,
} from './brain-links'

const day = 86_400_000
const september = Date.UTC(2026, 8, 1)
function link(patch: Partial<BrainLink> = {}): BrainLink {
  return {
    id: 'link-1',
    subjectId: 'tom',
    predicate: 'took_over_from',
    objectId: 'rina',
    memoryId: 'memory-1',
    label: '',
    validFrom: null,
    validTo: null,
    statedBy: 'reader',
    ...patch,
  }
}

it('joins people to people for reporting lines, working together and hand-overs', () => {
  expect(BRAIN_LINK_RULES.reports_to).toEqual({ subject: ['person'], object: ['person'] })
  expect(BRAIN_LINK_RULES.works_with).toEqual({
    subject: ['person', 'team'],
    object: ['person', 'team'],
  })
  expect(BRAIN_LINK_RULES.took_over_from).toEqual({
    subject: ['person', 'team'],
    object: ['person', 'team'],
  })
  expect(BRAIN_LINK_RULES.works_on.object).toContain('organization')
  expect(BRAIN_LINK_RULES.decided.object).toContain('organization')
  expect(Object.keys(BRAIN_PREDICATE_LABELS).sort()).toEqual([...BRAIN_PREDICATES].sort())
  expect(BRAIN_PREDICATE_LABELS.reports_to).toEqual({ out: 'Reports to', in: 'Manages' })
  expect(BRAIN_PREDICATE_LABELS.works_with).toEqual({ out: 'Works with', in: 'Works with' })
  expect(BRAIN_PREDICATE_LABELS.took_over_from).toEqual({
    out: 'Took over from',
    in: 'Handed over to',
  })
})

it('names the single-valued, symmetric and structural predicates and the label cap', () => {
  expect(BRAIN_SINGLE_VALUED_PREDICATES).toEqual(['reports_to'])
  expect(BRAIN_SYMMETRIC_PREDICATES).toEqual(['works_with'])
  expect(BRAIN_STRUCTURAL_PREDICATES).toEqual(
    expect.arrayContaining(['part_of', 'owns', 'member_of', 'leads', 'reports_to']),
  )
  expect(BRAIN_LINK_LABEL_MAX).toBe(80)
})

it('reads a link by its own wording, falling back to the predicate’s words', () => {
  expect(brainLinkWords(link({ label: 'took over Ledger billing from' }))).toBe(
    'took over Ledger billing from',
  )
  expect(brainLinkWords(link())).toBe('took over from')
  expect(brainLinkWords(link({ label: '   ', predicate: 'for_customer' }))).toBe('for customer')
  expect(brainLinkWords({ label: '  leads the  ', predicate: 'leads' })).toBe('leads the')
})

it('ends a link only once its end date has passed', () => {
  expect(brainLinkEnded(link(), september)).toBe(false)
  expect(brainLinkEnded(link({ validTo: september + day }), september)).toBe(false)
  expect(brainLinkEnded(link({ validTo: september }), september)).toBe(true)
  expect(brainLinkEnded(link({ validTo: september - day }), september)).toBe(true)
})

it('writes a link as a sentence with its dates', () => {
  expect(
    brainLinkSentence(
      link({ label: 'took over Ledger billing from', validFrom: september }),
      'Tom Lee',
      'Rina Okafor',
    ),
  ).toBe('Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)')
  expect(brainLinkSentence(link({ predicate: 'reports_to' }), 'Tom Lee', 'Mara Voss')).toBe(
    'Tom Lee reports to Mara Voss',
  )
  expect(
    brainLinkSentence(
      link({ predicate: 'works_on', validTo: Date.UTC(2026, 7, 15) }),
      'Tom Lee',
      'Kestrel',
    ),
  ).toBe('Tom Lee works on Kestrel (until 2026-08-15)')
  expect(
    brainLinkSentence(
      link({ predicate: 'leads', validFrom: Date.UTC(2026, 0, 5), validTo: september }),
      'Rina Okafor',
      'Harbor',
    ),
  ).toBe('Rina Okafor leads Harbor (2026-01-05 to 2026-09-01)')
})
