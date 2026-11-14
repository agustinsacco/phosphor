import { expect, it } from 'vitest'
import { blockedOnOwners, prCheck, prDetail, prSummary } from '../__fixtures__/pullRequests'
import { prChecklist } from './checklistRows'

const row = (rows: ReturnType<typeof prChecklist>, id: string) => rows.find((r) => r.id === id)

it('names an optional failure, waiting code owners, threads, branch and the merge block', () => {
  const rows = prChecklist(prSummary(), prDetail())
  expect(row(rows, 'checks')).toMatchObject({
    tone: 'bad',
    text: '6 passed; Rocky review failed (not required)',
    action: { kind: 'fix-checks', label: 'Fix' },
    expandable: true,
  })
  expect(row(rows, 'review')).toMatchObject({
    tone: 'wait',
    label: 'Code owners',
    text: 'Waiting on @core-reviewers. 2 approved',
    action: { kind: 'nudge-owners', label: 'Nudge' },
  })
  expect(row(rows, 'threads')).toMatchObject({
    tone: 'warn',
    text: '4 unresolved of 12',
    action: { kind: 'address-threads' },
  })
  expect(row(rows, 'branch')).toMatchObject({ tone: 'ok', text: 'No conflicts with main' })
  expect(row(rows, 'merge')).toMatchObject({
    tone: 'wait',
    text: 'Blocked: needs a code-owner review',
  })
  expect(row(rows, 'merge')?.action).toBeUndefined()
})

it('counts neutral checks and offers no fix when green', () => {
  const rows = prChecklist(blockedOnOwners())
  expect(row(rows, 'checks')).toMatchObject({ tone: 'ok', text: '6 passed, 1 neutral' })
  expect(row(rows, 'checks')?.action).toBeUndefined()
  expect(row(rows, 'threads')).toMatchObject({ tone: 'ok', text: 'All 8 resolved' })
})

it('asks to address requested changes and to update a conflicting branch', () => {
  const rows = prChecklist(
    prSummary({
      changesRequestedBy: ['kim'],
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
    }),
  )
  expect(row(rows, 'review')).toMatchObject({
    text: 'Changes requested by @kim',
    action: { kind: 'address-changes', label: 'Address' },
  })
  expect(row(rows, 'branch')).toMatchObject({
    tone: 'bad',
    text: 'Conflicts with main',
    action: { kind: 'update-branch', label: 'Update' },
  })
  expect(row(rows, 'merge')?.text).toBe('Blocked: conflicts with main')
})

it('says ready, with an Open button, only when nothing blocks and checks are known', () => {
  const ready = prSummary({
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    checkRuns: [prCheck('build', 'success', true)],
    checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    waitingOn: [],
  })
  expect(row(prChecklist(ready), 'merge')).toMatchObject({
    tone: 'ok',
    text: 'Ready. Merge on GitHub',
    action: { kind: 'open' },
  })
  expect(row(prChecklist(ready), 'review')).toMatchObject({
    tone: 'ok',
    text: 'Approved by @mara, @devon',
  })
  const unknown = { ...ready, checkRuns: null, checks: null }
  expect(row(prChecklist(unknown), 'checks')).toMatchObject({
    tone: 'wait',
    text: 'GitHub did not list the checks',
  })
  expect(row(prChecklist(unknown), 'merge')).toMatchObject({
    tone: 'wait',
    text: 'Checks unknown: confirm on GitHub',
  })
})

it('never reads truncated checks as green', () => {
  const rows = prChecklist(
    prSummary({ checksTruncated: true, checkRuns: [prCheck('build', 'success', true)] }),
  )
  expect(row(rows, 'checks')).toMatchObject({
    tone: 'wait',
    text: '1 passed. Over 100 checks: only some are listed',
  })
})

it('drops the threads row for a PR without threads and says so when there are too many', () => {
  expect(row(prChecklist(prSummary({ threads: { total: 0, unresolved: 0 } })), 'threads')).toBe(
    undefined,
  )
  expect(row(prChecklist(prSummary({ threads: null })), 'threads')?.text).toBe(
    'Over 100 threads: see GitHub',
  )
})
