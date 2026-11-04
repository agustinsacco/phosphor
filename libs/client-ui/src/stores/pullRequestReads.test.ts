import { expect, it } from 'vitest'
import { branchHasNoPullRequest, mergePullRequestRead } from './pullRequestReads'
import type { RepoPullRequests } from './pullRequests'

const pr = {
  number: 1,
  title: 'Known',
  state: 'OPEN' as const,
  url: 'https://github.com/a/b/pull/1',
}
const current: RepoPullRequests = {
  byBranch: { known: pr },
  complete: false,
  fetchedAt: 20,
  attemptedAt: 20,
  loading: false,
  coverage: {
    known: { state: 'found', checkedAt: 10, attemptedAt: 10 },
    absent: { state: 'absent', checkedAt: 11, attemptedAt: 11 },
  },
}
it('confirms absence per branch and revokes only the failed page, preserving successful observation ages', () => {
  expect(branchHasNoPullRequest(current, 'absent')).toBe(true)
  expect(branchHasNoPullRequest(current, 'uncovered')).toBe(false)
  const failed = mergePullRequestRead(current, null, ['known', 'absent'], 30)
  expect(failed.byBranch.known).toEqual(pr)
  expect(failed.coverage?.known).toEqual({
    state: 'unavailable',
    checkedAt: 10,
    attemptedAt: 30,
    reason: 'unavailable',
  })
  expect(branchHasNoPullRequest(failed, 'absent')).toBe(false)
  const recovered = mergePullRequestRead(
    failed,
    {
      byBranch: {},
      complete: false,
      coverage: {
        known: { state: 'absent', checkedAt: 40, attemptedAt: 40 },
      },
    },
    ['known'],
    41,
  )
  expect(recovered.byBranch.known).toBeUndefined()
  expect(branchHasNoPullRequest(recovered, 'known')).toBe(true)
  expect(recovered.coverage?.absent?.state).toBe('unavailable')
})
it('retains successful absence and chips outside a failed page', () => {
  const next = mergePullRequestRead(current, null, ['uncovered'], 30)
  expect(next.byBranch.known).toEqual(pr)
  expect(branchHasNoPullRequest(next, 'absent')).toBe(true)
  expect(next.coverage?.known).toEqual(current.coverage?.known)
})
