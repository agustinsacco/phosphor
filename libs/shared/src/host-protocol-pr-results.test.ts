import { describe, expect, it } from 'vitest'
import { prKey } from './github-pr-refs'
import type { GhPrDetail, GhPrSummary } from './models'
import { parsePrDetailResult, parsePrReadResult } from './host-protocol-pr-results'

const REF = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
const KEY = prKey(REF)
const SUMMARY: GhPrSummary = {
  number: 57,
  title: 'Refactor auth',
  state: 'OPEN',
  url: 'https://github.com/acme/app/pull/57',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  checks: { passed: 1, failed: 1, pending: 0, total: 2 },
  ref: REF,
  headRefName: 'feature/auth',
  baseRefName: 'main',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  comments: 1,
  updatedAt: '2026-11-01T00:00:00Z',
  author: 'octo',
  headSha: 'abc123',
  checkRuns: [
    { name: 'build', state: 'success', required: true },
    { name: 'bot', state: 'failure', required: false, title: '1 finding', url: 'https://ci/x' },
  ],
  checksTruncated: false,
  approvedBy: [],
  changesRequestedBy: [],
  waitingOn: [{ name: 'acme/owners', team: true, codeOwner: true }],
  threads: { total: 4, unresolved: 4 },
  inMergeQueue: false,
  autoMerge: false,
}
const COVERAGE = { state: 'found', checkedAt: 5, attemptedAt: 5 } as const
const DETAIL: GhPrDetail = {
  ref: REF,
  threads: [
    {
      path: 'src/a.ts',
      line: 3,
      outdated: false,
      author: 'rev',
      body: 'Why?',
      replies: 1,
      url: 'https://github.com/acme/app/pull/57#r1',
    },
  ],
  threadsTruncated: false,
  checks: [
    {
      name: 'bot',
      state: 'failure',
      required: false,
      workflow: 'CI',
      startedAt: '2026-11-01T00:00:00Z',
      annotations: [{ path: 'src/a.ts', line: 3, level: 'failure', message: 'bad' }],
    },
  ],
  checksTruncated: false,
  commented: ['rev'],
  activity: [{ kind: 'review', at: '2026-11-01T00:00:00Z', actor: 'rev', state: 'COMMENTED' }],
  checkedAt: 9,
}

describe('parsePrReadResult', () => {
  it('accepts what This Mac reader builds, for the refs asked', () => {
    const read = { byKey: { [KEY]: SUMMARY }, coverage: { [KEY]: COVERAGE } }
    expect(parsePrReadResult(read, [REF])).toEqual(read)
    const unknown = { byKey: {}, coverage: { [KEY]: { ...COVERAGE, state: 'unavailable' } } }
    expect(parsePrReadResult(unknown, [REF])).toEqual(unknown)
    expect(
      parsePrReadResult({ byKey: { [KEY]: { ...SUMMARY, checkRuns: null } }, coverage: {} }, [REF]),
    ).toMatchObject({ byKey: { [KEY]: { checkRuns: null } } })
  })

  it('refuses PRs nobody asked for and summaries out of shape', () => {
    const other = { ...REF, number: 58 }
    for (const bad of [
      null,
      { byKey: {} },
      { byKey: { [KEY]: SUMMARY }, coverage: { [prKey(other)]: COVERAGE } },
      { byKey: { [prKey(other)]: { ...SUMMARY, ref: other, number: 58 } }, coverage: {} },
      { byKey: { [KEY]: { ...SUMMARY, ref: other } }, coverage: {} },
      { byKey: { [KEY]: { ...SUMMARY, url: 'http://github.com/x' } }, coverage: {} },
      { byKey: { [KEY]: { ...SUMMARY, waitingOn: [{ name: 'x' }] } }, coverage: {} },
      { byKey: { [KEY]: { ...SUMMARY, threads: { total: -1, unresolved: 0 } } }, coverage: {} },
      { byKey: { [KEY]: { ...SUMMARY, additions: '10' } }, coverage: {} },
      { byKey: {}, coverage: { [KEY]: { ...COVERAGE, state: 'maybe' } } },
    ])
      expect(parsePrReadResult(bad, [REF]), JSON.stringify(bad)).toBeNull()
  })

  it('drops a check link that is not https without credentials', () => {
    const runs = [{ name: 'bot', state: 'failure', required: false, url: 'https://u:p@ci/x' }]
    const read = parsePrReadResult(
      { byKey: { [KEY]: { ...SUMMARY, checkRuns: runs } }, coverage: {} },
      [REF],
    )
    expect(read?.byKey[KEY]?.checkRuns).toStrictEqual([
      { name: 'bot', state: 'failure', required: false },
    ])
  })
})

describe('parsePrDetailResult', () => {
  it('accepts the inspector detail for the PR asked', () => {
    expect(parsePrDetailResult(DETAIL, REF)).toStrictEqual(DETAIL)
    expect(parsePrDetailResult({ ...DETAIL, checks: null }, REF)).toMatchObject({ checks: null })
  })

  it('refuses another PR, missing lists and unknown kinds', () => {
    for (const bad of [
      null,
      { ...DETAIL, ref: { ...REF, number: 58 } },
      { ...DETAIL, threads: undefined },
      { ...DETAIL, activity: [{ kind: 'pushed', at: 'x' }] },
      { ...DETAIL, checks: [{ ...DETAIL.checks![0], annotations: [{ level: 'loud' }] }] },
      { ...DETAIL, commented: [1] },
      { ...DETAIL, checkedAt: -1 },
    ])
      expect(parsePrDetailResult(bad, REF), JSON.stringify(bad)).toBeNull()
  })

  it('drops a thread link that is not https', () => {
    const detail = { ...DETAIL, threads: [{ ...DETAIL.threads[0], url: 'javascript:alert(1)' }] }
    expect(parsePrDetailResult(detail, REF)?.threads[0]).not.toHaveProperty('url')
  })
})
