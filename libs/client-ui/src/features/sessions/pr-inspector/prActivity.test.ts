import { expect, it } from 'vitest'
import { prDetail, prSummary } from '../__fixtures__/pullRequests'
import { activityLine, initials, mergedBy, newestFirst } from './prActivity'

it('words each timeline event with its tone', () => {
  const at = '2026-11-13T00:00:00Z'
  expect(activityLine({ kind: 'review', at, actor: 'kim', state: 'APPROVED' })).toEqual({
    text: '@kim approved',
    tone: 'good',
  })
  expect(activityLine({ kind: 'review', at, actor: 'kim', state: 'CHANGES_REQUESTED' }).tone).toBe(
    'warn',
  )
  expect(activityLine({ kind: 'commit', at, actor: 'a', text: 'fix it' }).text).toBe(
    '@a pushed: fix it',
  )
  expect(activityLine({ kind: 'requested', at, actor: 'a', text: 'core' }).text).toBe(
    '@a asked @core to review',
  )
  expect(activityLine({ kind: 'merged', at })).toEqual({
    text: 'Someone merged it',
    tone: 'merged',
  })
})

it('orders newest first and finds who merged', () => {
  const detail = prDetail({
    activity: [
      { kind: 'commit', at: '2026-11-10T00:00:00Z', actor: 'a' },
      { kind: 'merged', at: '2026-11-12T00:00:00Z', actor: 'mara' },
      { kind: 'review', at: '2026-11-11T00:00:00Z', actor: 'b', state: 'APPROVED' },
    ],
  })
  expect(newestFirst(detail.activity).map((e) => e.kind)).toEqual(['merged', 'review', 'commit'])
  expect(mergedBy(prSummary({ state: 'MERGED' }), detail)).toEqual({
    at: '2026-11-12T00:00:00Z',
    actor: 'mara',
  })
  expect(mergedBy(prSummary({ mergedAt: '2026-11-01T00:00:00Z' }))).toEqual({
    at: '2026-11-01T00:00:00Z',
    actor: undefined,
  })
})

it('makes initials from a login or a team', () => {
  expect(initials('kim')).toBe('KI')
  expect(initials('core-reviewers')).toBe('CR')
  expect(initials('nicole-augment')).toBe('NA')
  expect(initials('')).toBe('?')
})
