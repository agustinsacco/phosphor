import { expect, it } from 'vitest'
import { incrementalSegments, readBoundary, withoutOverlapClaims } from './incremental'
import { makeWindow } from './windows'
import type { LaneEntry } from './transcript'

const message = (id: string, parentId: string | null): LaneEntry => ({
  id,
  parentId,
  type: 'message',
  message: { role: 'user', content: `Harbor ${id}` },
})
const entries = [
  message('root', null),
  message('shared', 'root'),
  message('old', 'shared'),
  message('new', 'shared'),
]
it('falls back to the deepest common ancestor on a branch, or the beginning if it is gone', () => {
  expect(readBoundary(entries, 'new', 'old')).toEqual({ fromLeafId: 'shared', branched: true })
  expect(readBoundary(entries, 'new', 'missing')).toEqual({ fromLeafId: null, branched: true })
  const result = incrementalSegments(entries, 'new', 'shared')
  expect(result.selected.map((s) => [s.entryId, s.role])).toEqual([
    ['root', 'context'],
    ['shared', 'context'],
    ['new', 'user'],
  ])
  expect(result.source.map((s) => s.entryId)).toEqual(['root', 'shared', 'new'])
})
it('reads everything when no incremental cursor is set (including Read again)', () => {
  expect(readBoundary(entries, 'new', null)).toEqual({ fromLeafId: null, branched: false })
  expect(incrementalSegments(entries, 'new', null).selected.map((s) => s.role)).toEqual([
    'user',
    'user',
    'user',
  ])
})
it('drops and records overlap-only claims but keeps claims supported by a new message', () => {
  const { selected } = incrementalSegments(entries, 'new', 'shared')
  const memory = (ref: string, segment: string) => ({
    ref,
    text: 'Harbor billing',
    type: 'fact' as const,
    epistemic: 'reported' as const,
    mentions: [],
    links: [],
    branch: false,
    validFrom: null,
    validTo: null,
    quotes: [{ segment, quote: 'Harbor' }],
  })
  const filtered = withoutOverlapClaims({
    key: 'w1',
    window: makeWindow(selected),
    extraction: {
      entities: [],
      parents: [],
      claims: [memory('w1:old', 's1'), memory('w1:new', 's3')],
    },
  })
  expect(filtered.extraction.claims.map((c) => c.ref)).toEqual(['w1:new'])
  expect(filtered.extraction.outcomes).toEqual([
    {
      candidate: 'w1:old',
      summary: 'Harbor billing',
      status: 'dropped',
      reason: 'Claim supported only by previously read context',
    },
  ])
})
