import { expect, it } from 'vitest'
import { indexPrsByBranch } from './gh-cli'

it('keeps open PRs ahead of newer closed PRs and summarizes checks for shared clients', () => {
  expect(
    indexPrsByBranch([
      {
        number: 1,
        headRefName: 'lane',
        state: 'OPEN',
        url: 'https://github.com/a/b/pull/1',
        statusCheckRollup: [{ conclusion: 'FAILURE' }],
      },
      { number: 2, headRefName: 'lane', state: 'MERGED', url: 'https://github.com/a/b/pull/2' },
    ]),
  ).toMatchObject({ lane: { number: 1, state: 'OPEN', checks: { failed: 1, total: 1 } } })
})
