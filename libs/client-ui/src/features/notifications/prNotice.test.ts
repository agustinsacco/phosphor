import { describe, expect, it } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import { prChanges, type PrChange, type PrChangeKind } from '@/features/sessions/prChanges'
import { prCheck, prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import {
  mergeSince,
  prNativeNotice,
  prNoticeAction,
  prNoticeKind,
  prNoticePlace,
  prNoticeTitle,
  type PrNotice,
} from './prNotice'

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

describe('the native notice', () => {
  const ref = prRef(57, 'customer-secrets', 'acme')
  const BASE = 'private/customer-incident'
  const summary = prSummary({ ref, baseRefName: BASE, headRefName: 'agustin/acme-breach' })
  const notice = (place: PrNotice['lane'], changes: PrChange[]): PrNotice => ({
    key: prKey(ref),
    ref,
    lane: place,
    summary,
    changes,
  })
  const conflict = prChanges(summary, { ...summary, mergeable: 'CONFLICTING' })
  const studio = (hostId: string) => (hostId === 'h1' ? 'Studio' : hostId)

  it("keeps a This Mac lane's words: the change, the lane and the repository", () => {
    expect(prNativeNotice(notice(lane, conflict), studio)).toEqual({
      title: `#57 Now conflicts with ${BASE}`,
      body: 'Refactor auth module · customer-secrets',
    })
  })

  // A Host lane's lock-screen words: the PR number, the kind of change and the machine.
  const HOST_WORDS: Record<PrChangeKind, string> = {
    merged: 'Merged',
    closed: 'Closed',
    reopened: 'Reopened',
    'ready-for-review': 'Ready for review',
    'checks-failed': 'Checks failed',
    'checks-passed': 'Checks passed',
    approved: 'Approved',
    'changes-requested': 'Changes requested',
    conflict: 'Branch conflict',
    'conflict-resolved': 'Conflict resolved',
    'ready-to-merge': 'Ready to merge',
    'threads-added': 'New review threads',
    'threads-resolved': 'Threads resolved',
    pushed: 'New commits pushed',
  }
  const hostLane = { hostId: 'h1', laneId: 'l1', title: 'Fix acme /srv/acme/customer-secrets' }
  const PRIVATE = [BASE, 'agustin/acme-breach', 'acme', 'customer-secrets', '/srv', '@mara']

  it.each(Object.entries(HOST_WORDS))(
    "words a Host lane's %s change without branch, repository or path",
    (kind, words) => {
      const leak = `${PRIVATE.join(' ')} failed`
      const changes = [{ ...change(leak), kind: kind as PrChangeKind }]
      const native = prNativeNotice(notice(hostLane, changes), studio)
      expect([native.title, native.body]).toEqual([`#57 ${words}`, 'Studio'])
      for (const text of PRIVATE) expect(`${native.title}\n${native.body}`).not.toContain(text)
      expect(native).toMatchObject({ key: `pr:${prKey(ref)}`, route: { hostId: 'h1', pr: ref } })
    },
  )

  it("never words a Host lane's conflict with its base branch", () => {
    expect(prNativeNotice(notice(hostLane, conflict), studio)).toMatchObject({
      title: '#57 Branch conflict',
      body: 'Studio',
    })
  })
})
