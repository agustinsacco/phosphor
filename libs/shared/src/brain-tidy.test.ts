import { expect, expectTypeOf, it } from 'vitest'
import type { BrainEntityKind } from './brain'
import {
  BRAIN_TIDY_KINDS,
  checkBrainTidyAction,
  type BrainTidyAction,
  type BrainTidyOperation,
  type BrainTidySource,
  type BrainTidySuggestion,
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
  { kind: 'group' },
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
  { kind: 'group', parentId: 'harbor' },
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
    | 'read'
    | 'relate'
    | 'relation'
    | 'importance'
    | 'group'
  >()
})

it('offers identity guesses, groups and unlinked pairs for Brain Agent to settle', () => {
  expect(BRAIN_TIDY_KINDS).toEqual([
    'same_entity',
    'group',
    'unlinked',
    'same_memory',
    'conflict',
    'flagged',
  ])
  expectTypeOf<BrainTidySource>().toEqualTypeOf<'sweep' | 'check' | 'flag' | 'read'>()
  expectTypeOf<BrainTidySuggestion['detail']>().toEqualTypeOf<
    | { kind: 'guess'; jobId: string }
    | {
        kind: 'group'
        jobId: string
        parent: { label: string; kind: BrainEntityKind; entityId: string | null }
        memberIds: string[]
      }
    | { kind: 'unlinked'; shared: number; memoryIds: string[] }
    | null
  >()
})

it('keeps only automatic fold notice fields in the local sweep status', () => {
  expectTypeOf<BrainTidySummary>().toEqualTypeOf<{
    automaticFolds: number
    newestAutomaticFoldAt: number | null
  }>()
})
