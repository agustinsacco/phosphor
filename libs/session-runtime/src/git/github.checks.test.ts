import { describe, expect, it } from 'vitest'
import { summarizeChecks, indexPrsByBranch } from './github'

describe('summarizeChecks', () => {
  it('is undefined when there are no checks at all', () => {
    expect(summarizeChecks(undefined)).toBeUndefined()
    expect(summarizeChecks([])).toBeUndefined()
  })

  it('counts CheckRun conclusions', () => {
    expect(
      summarizeChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS' },
      ]),
    ).toEqual({ passed: 1, failed: 1, pending: 1, total: 3 })
  })

  it('understands StatusContext entries, which use `state` not `conclusion`', () => {
    // A repo mixing Actions with an external reporter (e.g. Vercel) returns
    // both shapes in one rollup; counting only `conclusion` would call the
    // external ones pending forever.
    expect(
      summarizeChecks([
        { __typename: 'StatusContext', state: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'ERROR' },
        { __typename: 'StatusContext', state: 'PENDING' },
      ]),
    ).toEqual({ passed: 1, failed: 1, pending: 1, total: 3 })
  })

  it('treats neutral and skipped as passing, not failing', () => {
    expect(
      summarizeChecks([
        { conclusion: 'NEUTRAL', status: 'COMPLETED' },
        { conclusion: 'SKIPPED', status: 'COMPLETED' },
      ]),
    ).toEqual({ passed: 2, failed: 0, pending: 0, total: 2 })
  })

  it('counts queued and pending work as pending', () => {
    expect(
      summarizeChecks([
        { status: 'QUEUED' },
        { status: 'PENDING' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toEqual({ passed: 1, failed: 0, pending: 2, total: 3 })
  })

  it('counts cancelled and timed_out as failures', () => {
    expect(
      summarizeChecks([
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
        { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      ]),
    ).toEqual({ passed: 0, failed: 2, pending: 0, total: 2 })
  })
})

describe('indexPrsByBranch', () => {
  const row = (over: Record<string, unknown>): never =>
    ({ number: 1, url: 'https://x/1', state: 'OPEN', headRefName: 'b', ...over }) as never

  it('keys by head branch and shapes each PR', () => {
    const byBranch = indexPrsByBranch([
      row({ number: 412, headRefName: 'feat/a', state: 'MERGED', title: 'A' }),
      row({ number: 418, headRefName: 'feat/b', state: 'OPEN', reviewDecision: 'APPROVED' }),
    ])
    expect(byBranch['feat/a']?.state).toBe('MERGED')
    expect(byBranch['feat/b']?.reviewDecision).toBe('APPROVED')
  })

  it('marks a draft, which gh reports as OPEN plus a flag', () => {
    const byBranch = indexPrsByBranch([row({ headRefName: 'd', state: 'OPEN', isDraft: true })])
    expect(byBranch['d']?.state).toBe('DRAFT')
  })

  it('prefers the open PR when a branch has been reused', () => {
    const byBranch = indexPrsByBranch([
      row({ number: 500, headRefName: 'reused', state: 'CLOSED' }),
      row({ number: 300, headRefName: 'reused', state: 'OPEN' }),
    ])
    expect(byBranch['reused']?.number).toBe(300)
  })

  it('falls back to the newest when both are closed', () => {
    const byBranch = indexPrsByBranch([
      row({ number: 300, headRefName: 'old', state: 'CLOSED' }),
      row({ number: 500, headRefName: 'old', state: 'MERGED' }),
    ])
    expect(byBranch['old']?.number).toBe(500)
  })

  it('skips rows with no branch or no url rather than inventing entries', () => {
    expect(indexPrsByBranch([row({ headRefName: undefined })])).toEqual({})
    expect(indexPrsByBranch([row({ url: undefined })])).toEqual({})
  })
})
