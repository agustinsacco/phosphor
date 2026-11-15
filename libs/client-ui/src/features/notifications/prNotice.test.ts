import { expect, it } from 'vitest'
import type { PrChange } from '@/features/sessions/prChanges'
import { prCheck, prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import { mergeSince, prNoticeAction, prNoticeKind, prNoticePlace, prNoticeTitle } from './prNotice'

const change = (text: string, tone: PrChange['tone'] = 'bad'): PrChange => ({
  kind: 'checks-failed',
  text,
  tone,
  important: true,
})
const lane = { path: '/s/a.jsonl', workspacePath: '/repo', title: 'Refactor auth module' }

it('words the notice from its newest change, the lane and the repository', () => {
  const notice = { ref: prRef(57), lane, changes: [change('Rocky review failed (not required)')] }
  expect(prNoticeTitle(notice)).toBe('#57 Rocky review failed (not required)')
  expect(prNoticePlace(notice)).toBe('Refactor auth module · Phosphor#57')
  expect(prNoticeKind(notice)).toBe('error')
  expect(prNoticeKind({ changes: [change('@kim approved', 'good')] })).toBe('success')
  expect(prNoticeKind({ changes: [change('Merged', 'merged')] })).toBe('info')
})

it('keeps every unseen change once, newest first', () => {
  const since = mergeSince(
    [change('unit failed'), change('@kim approved', 'good')],
    [change('@kim approved', 'good'), change('Now conflicts with main')],
  )
  expect(since.map((c) => c.text)).toEqual([
    'unit failed',
    '@kim approved',
    'Now conflicts with main',
  ])
})

it('offers the hand-off the PR needs now, GitHub when ready, nothing once merged', () => {
  expect(prNoticeAction(prSummary())).toMatchObject({
    handoff: 'fix-checks',
    label: 'Ask agent to fix',
  })
  expect(
    prNoticeAction(
      prSummary({
        checkRuns: [prCheck('build', 'success', true)],
        checks: { passed: 1, failed: 0, pending: 0, total: 1 },
        changesRequestedBy: ['kim'],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    ),
  ).toMatchObject({ handoff: 'address-changes', label: 'Ask agent to address' })
  expect(prNoticeAction(prSummary({ mergeable: 'CONFLICTING' }))).toMatchObject({
    handoff: 'update-branch',
    label: 'Ask agent to update',
  })
  expect(
    prNoticeAction(
      prSummary({
        checkRuns: [prCheck('build', 'success', true)],
        checks: { passed: 1, failed: 0, pending: 0, total: 1 },
        reviewDecision: 'APPROVED',
        waitingOn: [],
        threads: { total: 0, unresolved: 0 },
      }),
    ),
  ).toEqual({ kind: 'github', label: 'Open on GitHub' })
  expect(prNoticeAction(prSummary({ state: 'MERGED' }))).toBeNull()
})
