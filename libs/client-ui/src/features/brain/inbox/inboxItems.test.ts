import { expect, it } from 'vitest'
import type { BrainTidyPage, BrainTidySuggestion } from '@shared/brain-tidy'
import { mockBrainJob, mockBrainStatus } from '../mockBrainData'
import {
  heldSuggestion,
  inboxCount,
  inboxGroups,
  inboxOrder,
  keepInboxSelection,
  moveInboxSelection,
} from './inboxItems'

function suggestion(id: string, kind: BrainTidySuggestion['kind']): BrainTidySuggestion {
  return {
    id,
    kind,
    state: 'open',
    reason: 'These records share a name.',
    source: 'sweep',
    model: null,
    verdict: null,
    flag: null,
    subjects: [{ type: 'entity', id: `${id}-a`, label: 'Rina' }],
    createdAt: 0,
    updatedAt: 0,
  }
}
const none: BrainTidyPage['counts'] = { same_entity: 0, same_memory: 0, conflict: 0, flagged: 0 }
function page(items: BrainTidySuggestion[], counts: BrainTidyPage['counts']): BrainTidyPage {
  return { items, counts, next: null, revision: 0 } as unknown as BrainTidyPage
}

it('groups reviews oldest first, then Tidy suggestions in the fixed kind order', () => {
  const jobs = [
    mockBrainJob({ id: 'kestrel', queuedAt: 3 }),
    mockBrainJob({ id: 'running', state: 'running', queuedAt: 1 }),
    mockBrainJob({ id: 'harbor', queuedAt: 2 }),
  ]
  const groups = inboxGroups(
    jobs,
    page(
      [
        suggestion('flag', 'flagged'),
        suggestion('pair', 'same_entity'),
        suggestion('repeat', 'same_memory'),
        { ...suggestion('done', 'conflict'), state: 'applied' },
      ],
      { same_entity: 3, same_memory: 1, conflict: 0, flagged: 1 },
    ),
  )
  expect(groups.map((group) => [group.label, group.total])).toEqual([
    ['From lanes', 2],
    ['Same person or thing?', 3],
    ['Said twice', 1],
    ['Flagged by a lane', 1],
  ])
  expect(inboxOrder(groups).map((item) => item.key)).toEqual([
    'review:harbor',
    'review:kestrel',
    'suggestion:pair',
    'suggestion:repeat',
    'suggestion:flag',
  ])
})

it('counts reviews and open suggestions for the nav item and the tab', () => {
  const status = {
    ...mockBrainStatus(),
    jobs: [mockBrainJob(), mockBrainJob({ id: 'q', state: 'queued' })],
  }
  status.tidy = { ...status.tidy, open: 4 }
  expect(inboxCount(status)).toBe(5)
  expect(inboxCount(null)).toBe(0)
})

it('keeps the selection, or takes the item after it, then the one before, then the first', () => {
  const items = inboxOrder(
    inboxGroups(
      [mockBrainJob({ id: 'a', queuedAt: 1 }), mockBrainJob({ id: 'c', queuedAt: 9 })],
      null,
    ),
  )
  const previous = ['review:a', 'review:b', 'review:c']
  expect(keepInboxSelection(previous, items, 'review:a')).toBe('review:a')
  expect(keepInboxSelection(previous, items, 'review:b')).toBe('review:c')
  expect(keepInboxSelection(['review:a', 'review:c', 'review:d'], items, 'review:d')).toBe(
    'review:c',
  )
  expect(keepInboxSelection([], items, 'review:gone')).toBe('review:a')
  expect(keepInboxSelection(previous, [], 'review:b')).toBeNull()
})

it('moves with j and k without leaving the list', () => {
  const items = inboxOrder(
    inboxGroups(
      [mockBrainJob({ id: 'a', queuedAt: 1 }), mockBrainJob({ id: 'b', queuedAt: 9 })],
      null,
    ),
  )
  expect(moveInboxSelection(items, 'review:a', 1)).toBe('review:b')
  expect(moveInboxSelection(items, 'review:b', 1)).toBe('review:b')
  expect(moveInboxSelection(items, 'review:a', -1)).toBe('review:a')
  expect(moveInboxSelection(items, null, 1)).toBe('review:a')
  expect(moveInboxSelection([], null, 1)).toBeNull()
})

it('holds the open suggestion a reload pushed off the page until it is really gone', () => {
  const [a, b, c, fresh] = ['a', 'b', 'c', 'new'].map((id) => suggestion(id, 'same_entity'))
  const before = inboxOrder(inboxGroups([], page([a!, b!, c!], { ...none, same_entity: 3 })))
  const previous = before.map((item) => item.key)
  const after = page([fresh!, a!, b!], { ...none, same_entity: 4 })
  const held = heldSuggestion(after, c!, 'suggestion:c', null)
  expect(held).toBe(c)
  const items = inboxOrder(inboxGroups([], after, held))
  expect(items.map((item) => item.key)).toEqual([
    'suggestion:new',
    'suggestion:a',
    'suggestion:b',
    'suggestion:c',
  ])
  expect(keepInboxSelection(previous, items, 'suggestion:c')).toBe('suggestion:c')
  // Gone: its detail said so, or every open one of its kind is loaded without it.
  expect(heldSuggestion(after, c!, 'suggestion:c', 'suggestion:c')).toBeNull()
  expect(
    heldSuggestion(page([fresh!, a!, b!], { ...none, same_entity: 3 }), c!, 'suggestion:c', null),
  ).toBeNull()
  // Nothing to hold: another selection, or the row is still loaded.
  expect(heldSuggestion(after, c!, 'suggestion:a', null)).toBeNull()
  expect(heldSuggestion(after, a!, 'suggestion:a', null)).toBeNull()
})

it('shows a kind with open suggestions before any of them is loaded', () => {
  const repeats = ['r1', 'r2'].map((id) => suggestion(id, 'same_memory'))
  const groups = inboxGroups([], page(repeats, { ...none, same_entity: 5, same_memory: 45 }))
  expect(groups.map((group) => [group.id, group.items.length, group.total])).toEqual([
    ['same_entity', 0, 5],
    ['same_memory', 2, 45],
  ])
})
