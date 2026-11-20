import { expect, expectTypeOf, it } from 'vitest'
import {
  checkBrainTidyAction,
  type BrainTidyAction,
  type BrainTidyOperation,
  type BrainTidySummary,
  type BrainTidySuggestionDetail,
} from './brain-tidy'

it.each([
  { kind: 'merge', survivorId: 'rina' },
  { kind: 'fold', survivorId: 'harbor' },
  { kind: 'replace', newerId: 'ledger' },
  { kind: 'dispute' },
  { kind: 'forget' },
  { kind: 'keep' },
  { kind: 'unname', entityId: 'kestrel-launch', name: 'Harbor' },
])('accepts only the explicit Tidy action %j', (action) => {
  expect(checkBrainTidyAction(action)).toEqual(action)
})
it.each([
  null,
  [],
  'forget',
  { kind: 'merge' },
  { kind: 'fold', survivorId: '' },
  { kind: 'replace', newerId: 4 },
  { kind: 'keep', extra: true },
  { kind: 'delete' },
  { kind: 'unname', entityId: 'kestrel-launch' },
  { kind: 'unname', entityId: '', name: 'Harbor' },
  { kind: 'unname', entityId: 'kestrel-launch', name: 'x'.repeat(201) },
  { kind: 'unname', entityId: 'kestrel-launch', name: 'Harbor', extra: true },
])('rejects malformed action %j', (action) => {
  expect(() => checkBrainTidyAction(action)).toThrow('Invalid Brain Tidy action.')
})

it('freezes the engine-owned action availability fields on suggestion details', () => {
  expectTypeOf<BrainTidySuggestionDetail['allowed']>().toEqualTypeOf<BrainTidyAction['kind'][]>()
  expectTypeOf<BrainTidySuggestionDetail['foldRefusal']>().toEqualTypeOf<
    'applicability' | 'history' | null
  >()
})

it('freezes the reversible operation kinds', () => {
  expectTypeOf<BrainTidyOperation['kind']>().toEqualTypeOf<
    | 'merge'
    | 'fold'
    | 'dispute'
    | 'replace'
    | 'split'
    | 'unname'
    | 'describe'
    | 'approve'
    | 'reject'
    | 'keep'
    | 'correct'
    | 'erase'
  >()
})

it('keeps only automatic fold notice fields in the local sweep status', () => {
  expectTypeOf<BrainTidySummary>().toEqualTypeOf<{
    automaticFolds: number
    newestAutomaticFoldAt: number | null
  }>()
})
