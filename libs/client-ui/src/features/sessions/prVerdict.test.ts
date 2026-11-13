import { describe, expect, it } from 'vitest'
import type { GhPrCheck, GhPrSummary } from '@shared/models'
import { mergeBlock, prStages, prVerdict } from './prVerdict'

const check = (name: string, state: GhPrCheck['state'], required = false): GhPrCheck => ({
  name,
  state,
  required,
})
/** Shaped like a real PR: green except an optional reviewer bot, waiting on code owners. */
const summary = (patch: Partial<GhPrSummary> = {}): GhPrSummary => ({
  ref: { host: 'github.com', owner: 'o', repo: 'r', number: 1 },
  number: 1,
  title: 'Generate the CLI',
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/1',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  checks: { passed: 2, failed: 1, pending: 0, total: 3 },
  headRefName: 'agustin/cli',
  baseRefName: 'main',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  comments: 0,
  updatedAt: '2026-11-12T00:00:00Z',
  checkRuns: [
    check('build', 'success', true),
    check('test', 'success', true),
    { ...check('Rocky review', 'failure'), title: '1 unresolved finding' },
  ],
  checksTruncated: false,
  approvedBy: ['nicole', 'darlinton'],
  changesRequestedBy: [],
  waitingOn: [{ name: 'eng-managers', team: true, codeOwner: true }],
  threads: { total: 12, unresolved: 4 },
  inMergeQueue: false,
  autoMerge: false,
  ...patch,
})
const green = [check('build', 'success', true), check('test', 'success', true)]

describe('prVerdict', () => {
  it('reads an optional failure as red, but blames the merge on code owners', () => {
    const pr = summary()
    expect(prVerdict(pr)).toMatchObject({
      tone: 'failing',
      rank: 3,
      headline: 'Rocky review failed (not required)',
    })
    expect(prVerdict(pr).blockers.map((b) => b.kind)).toEqual(['checks', 'threads', 'review'])
    expect(mergeBlock(pr)).toBe('needs a code-owner review')
  })

  it.each([
    [
      'a required check failing',
      { checkRuns: [check('build', 'failure', true)] },
      ['failing', 0, '1 required check failing'],
    ],
    [
      'a conflict',
      { mergeable: 'CONFLICTING', checkRuns: green },
      ['conflict', 1, 'Conflicts with main'],
    ],
    [
      'changes requested',
      { checkRuns: green, changesRequestedBy: ['nebez'], reviewDecision: 'CHANGES_REQUESTED' },
      ['blocked', 2, 'Changes requested by @nebez'],
    ],
    [
      'checks running',
      { checkRuns: [...green, check('e2e', 'pending', true)], threads: null, waitingOn: [] },
      ['pending', 4, 'Checks running, 1 left'],
    ],
    [
      'code owners',
      { checkRuns: green, threads: null },
      ['review', 5, 'Waiting on code owners @eng-managers'],
    ],
    [
      'ready',
      { checkRuns: green, threads: null, waitingOn: [], reviewDecision: 'APPROVED' },
      ['ready', 6, 'Approved, checks green: ready to merge'],
    ],
    ['a draft', { state: 'DRAFT', checkRuns: green }, ['draft', 7, 'Draft']],
    ['merged', { state: 'MERGED' }, ['merged', 8, 'Merged']],
    ['closed', { state: 'CLOSED' }, ['closed', 9, 'Closed without merging']],
  ] as const)('ranks %s', (_name, patch, [tone, rank, headline]) => {
    expect(prVerdict(summary(patch as Partial<GhPrSummary>))).toMatchObject({
      tone,
      rank,
      headline,
    })
  })

  it('never calls unknown or truncated checks green', () => {
    const approved: Partial<GhPrSummary> = {
      reviewDecision: 'APPROVED',
      waitingOn: [],
      threads: null,
    }
    expect(prVerdict(summary({ ...approved, checkRuns: null, checks: null })).tone).toBe('review')
    expect(
      prVerdict(summary({ ...approved, checkRuns: green, checks: null, checksTruncated: true }))
        .tone,
    ).toBe('review')
    expect(prStages(summary({ checkRuns: null, checks: null }))[1]?.state).toBe('unknown')
  })

  it('never calls a PR with no CI ready to merge', () => {
    const approved: Partial<GhPrSummary> = {
      reviewDecision: 'APPROVED',
      waitingOn: [],
      threads: null,
    }
    expect(prVerdict(summary({ ...approved, checkRuns: [], checks: undefined }))).toMatchObject({
      tone: 'review',
      headline: 'Approved; no checks reported',
    })
    const counted = {
      number: 3,
      title: 'x',
      state: 'OPEN' as const,
      url: 'u',
      reviewDecision: 'APPROVED' as const,
    }
    expect(
      prVerdict({ ...counted, checks: { passed: 0, failed: 0, pending: 0, total: 0 } }).tone,
    ).toBe('review')
    expect(prVerdict(counted).headline).toBe('Approved; checks unknown')
  })

  it('reads branch discovery’s counts without claiming which checks are required', () => {
    const pr = {
      number: 2,
      title: 'x',
      state: 'OPEN' as const,
      url: 'https://github.com/o/r/pull/2',
      checks: { passed: 1, failed: 1, pending: 0, total: 2 },
    }
    expect(prVerdict(pr)).toMatchObject({ tone: 'failing', rank: 0, headline: '1 check failing' })
    expect(prVerdict({ ...pr, mergeStateStatus: 'UNSTABLE' })).toMatchObject({ rank: 3 })
  })

  it('lays out the stages to landing', () => {
    expect(prStages(summary()).map((s) => s.state)).toEqual(['done', 'fail', 'part', 'wait'])
    expect(
      prStages(summary({ checkRuns: green, reviewDecision: 'APPROVED' })).map((s) => s.state),
    ).toEqual(['done', 'done', 'done', 'ready'])
  })
})
