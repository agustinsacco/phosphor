import { expect, it } from 'vitest'
import { checkBrainTidyAction } from './brain-tidy'

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
