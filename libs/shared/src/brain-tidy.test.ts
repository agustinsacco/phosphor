import { expect, expectTypeOf, it } from 'vitest'
import {
  checkBrainTidyAction,
  type BrainTidyAction,
  type BrainTidySuggestionDetail,
} from './brain-tidy'

it.each([
  { kind: 'merge', survivorId: 'rina' },
  { kind: 'fold', survivorId: 'harbor' },
  { kind: 'replace', newerId: 'ledger' },
  { kind: 'dispute' },
  { kind: 'forget' },
  { kind: 'keep' },
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
])('rejects malformed action %j', (action) => {
  expect(() => checkBrainTidyAction(action)).toThrow('Invalid Brain Tidy action.')
})

it('freezes the engine-owned action availability fields on suggestion details', () => {
  expectTypeOf<BrainTidySuggestionDetail['allowed']>().toEqualTypeOf<BrainTidyAction['kind'][]>()
  expectTypeOf<BrainTidySuggestionDetail['foldRefusal']>().toEqualTypeOf<
    'applicability' | 'history' | null
  >()
})

it('freezes explicit Tidy run states, including skipped and interrupted', () => {
  expectTypeOf<import('./brain-tidy').BrainTidyRun['state']>().toEqualTypeOf<
    'queued' | 'sweeping' | 'checking' | 'done' | 'cancelled' | 'failed' | 'skipped' | 'interrupted'
  >()
})
