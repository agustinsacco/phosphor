import { expect, it } from 'vitest'
import { blockedOnOwners, prCheck, prSummary } from './__fixtures__/pullRequests'
import { prChanges } from './prChanges'

const kinds = (changes: ReturnType<typeof prChanges>) => changes.map((c) => c.kind)

it('says nothing when nothing a person cares about moved', () => {
  expect(prChanges(prSummary(), prSummary({ updatedAt: 'later', comments: 12 }))).toEqual([])
})

it('reports a merge alone, however much else changed with it', () => {
  const after = prSummary({ state: 'MERGED', approvedBy: ['mara', 'devon', 'kim'] })
  expect(prChanges(prSummary(), after)).toEqual([
    { kind: 'merged', text: 'Merged', tone: 'merged', important: true },
  ])
})

it('names a newly failing check and whether it is required', () => {
  const before = blockedOnOwners()
  const after = blockedOnOwners()
  after.checkRuns = [...after.checkRuns!, prCheck('build', 'failure', true)]
  after.checks = { passed: 6, failed: 1, pending: 0, total: 7 }
  const [change] = prChanges(before, after)
  expect(change).toEqual({
    kind: 'checks-failed',
    text: 'build failed',
    tone: 'bad',
    important: true,
  })
  const optional = prChanges(before, { ...after, checkRuns: [prCheck('Rocky', 'failure')] })
  expect(optional[0]?.text).toBe('Rocky failed (not required)')
})

it('reports checks going green again, new approvals and resolved threads', () => {
  const before = prSummary({ checkRuns: [prCheck('build', 'failure', true)] })
  const after = prSummary({
    checkRuns: [prCheck('build', 'success', true)],
    checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    approvedBy: ['mara', 'devon', 'kim'],
    threads: { total: 12, unresolved: 0 },
  })
  const changes = prChanges(before, after)
  expect(kinds(changes)).toEqual(['checks-passed', 'approved', 'threads-resolved'])
  expect(changes[1]!.text).toBe('@kim approved')
})

it('reports becoming ready to merge first', () => {
  const before = prSummary({
    checkRuns: [prCheck('build', 'success', true)],
    reviewDecision: 'REVIEW_REQUIRED',
  })
  const after = prSummary({
    checkRuns: [prCheck('build', 'success', true)],
    checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    waitingOn: [],
  })
  expect(kinds(prChanges(before, after))[0]).toBe('ready-to-merge')
})

it('reports conflicts, pushes and changes requested', () => {
  const after = prSummary({
    mergeable: 'CONFLICTING',
    headSha: 'f00',
    changesRequestedBy: ['lee'],
  })
  expect(kinds(prChanges(prSummary(), after))).toEqual(['changes-requested', 'conflict', 'pushed'])
})
