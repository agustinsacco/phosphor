import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GithubCommand, GithubCommandResult } from './github-command'
import { GithubGate } from './github-gate'
import { createGithubPrStatusReader } from './github-pr-status'
import { summaryQuery, type RawSummary } from './github-pr-summary'

const ref = (number: number, repo = 'repo', host = 'github.com') => ({
  host,
  owner: 'Example',
  repo,
  number,
})
const key = (number: number, repo = 'repo') => `github.com/example/${repo}#${number}`

/** The shape GitHub returned for a real PR blocked only on an optional check and code owners. */
const raw = (number: number, patch: Partial<RawSummary> = {}): RawSummary => ({
  number,
  title: 'Generate the chat-service CLI',
  url: `https://github.com/Example/repo/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'agustin/cli',
  baseRefName: 'main',
  additions: 1200,
  deletions: 980,
  changedFiles: 31,
  updatedAt: '2026-11-12T15:48:50Z',
  mergedAt: null,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  isInMergeQueue: false,
  autoMergeRequest: null,
  author: { login: 'agustin' },
  headRefOid: 'abc123',
  comments: { totalCount: 3 },
  reviewThreads: {
    totalCount: 3,
    nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }],
  },
  latestOpinionatedReviews: {
    nodes: [
      { state: 'APPROVED', author: { login: 'nicole' } },
      { state: 'COMMENTED', author: { login: 'kevin' } },
    ],
  },
  reviewRequests: {
    nodes: [
      { asCodeOwner: false, requestedReviewer: { __typename: 'User', login: 'andy' } },
      { asCodeOwner: true, requestedReviewer: { __typename: 'Team', slug: 'eng-managers' } },
    ],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'build',
                  status: 'COMPLETED',
                  conclusion: 'SUCCESS',
                  isRequired: true,
                },
                {
                  __typename: 'CheckRun',
                  name: 'Rocky review',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE',
                  title: '1 unresolved finding',
                  detailsUrl: 'https://github.com/Example/repo/runs/1',
                  isRequired: false,
                },
                {
                  __typename: 'StatusContext',
                  context: 'deploy/preview',
                  state: 'PENDING',
                  isRequired: false,
                },
              ],
            },
          },
        },
      },
    ],
  },
  ...patch,
})

let calls: string[][]
let replies: ((args: string[]) => GithubCommandResult)[]
const command: GithubCommand = async (_cwd, args) => {
  calls.push(args)
  return (replies.shift() ?? (() => ({ ok: false, reason: 'unavailable' }) as const))(args)
}
const answer =
  (repository: Record<string, RawSummary | null>, errors?: object[]) =>
  (): GithubCommandResult => ({
    ok: true,
    stdout: JSON.stringify({ data: { repository }, ...(errors ? { errors } : {}) }),
  })

let gate: GithubGate
let reader: ReturnType<typeof createGithubPrStatusReader>
beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  replies = []
  gate = new GithubGate(command)
  reader = createGithubPrStatusReader({ gate, cwd: '/' })
})
afterEach(() => vi.useRealTimers())

it('reads one query per repository and shapes checks, reviews and threads', async () => {
  replies.push(answer({ p1: raw(1), p2: raw(2) }))
  const read = await reader.read([ref(1), ref(2)])
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('--hostname')
  const pr = read!.byKey[key(1)]!
  expect(pr).toMatchObject({
    number: 1,
    state: 'OPEN',
    checks: { passed: 1, failed: 1, pending: 1, total: 3 },
    approvedBy: ['nicole'],
    changesRequestedBy: [],
    waitingOn: [
      { name: 'eng-managers', team: true, codeOwner: true },
      { name: 'andy', team: false, codeOwner: false },
    ],
    threads: { total: 3, unresolved: 2 },
    checksTruncated: false,
  })
  expect(pr.checkRuns).toEqual([
    { name: 'build', state: 'success', required: true },
    {
      name: 'Rocky review',
      state: 'failure',
      required: false,
      title: '1 unresolved finding',
      url: 'https://github.com/Example/repo/runs/1',
    },
    { name: 'deploy/preview', state: 'pending', required: false },
  ])
  expect(read!.coverage[key(1)]?.state).toBe('found')
})

it('asks isRequired per PR number', () => {
  expect(summaryQuery([ref(7)], true)).toContain('isRequired(pullRequestNumber:7)')
  expect(summaryQuery([ref(7)], false)).not.toContain('statusCheckRollup')
})

it('marks only the number GitHub says is missing as absent', async () => {
  replies.push(
    answer({ p1: raw(1), p404: null }, [{ type: 'NOT_FOUND', path: ['repository', 'p404'] }]),
  )
  const read = await reader.read([ref(1), ref(404)])
  expect(read!.coverage[key(404)]?.state).toBe('absent')
  expect(read!.coverage[key(1)]?.state).toBe('found')
})

it('keeps the last summary when a read fails, and backs off', async () => {
  replies.push(answer({ p1: raw(1) }))
  await reader.read([ref(1)])
  vi.advanceTimersByTime(16_000)
  const failed = await reader.read([ref(1)])
  expect(failed!.byKey[key(1)]?.number).toBe(1)
  expect(failed!.coverage[key(1)]).toMatchObject({ state: 'unavailable', reason: 'unavailable' })
  await reader.read([ref(1)], { force: true })
  expect(calls).toHaveLength(2)
})

it('stops polling merged PRs and reuses fresh reads', async () => {
  replies.push(answer({ p1: raw(1, { state: 'MERGED', mergedAt: '2026-11-12T00:00:00Z' }) }))
  await reader.read([ref(1)])
  vi.advanceTimersByTime(10 * 60_000)
  await reader.read([ref(1)])
  expect(calls).toHaveLength(1)
})

it('collapses concurrent reads into one query', async () => {
  replies.push(answer({ p1: raw(1) }))
  await Promise.all([reader.read([ref(1)]), reader.read([ref(1)])])
  expect(calls).toHaveLength(1)
})

it('retries without checks when GitHub runs out of resources, and never reads that as green', async () => {
  replies.push(() => ({ ok: false, reason: 'unavailable', retryWithoutChecks: true }))
  replies.push(answer({ p1: raw(1, { commits: undefined }) }))
  const read = await reader.read([ref(1)])
  expect(calls).toHaveLength(2)
  expect(read!.byKey[key(1)]).toMatchObject({ checks: null, checkRuns: null })
})

it('refuses untrusted hosts and malformed refs without running gh', async () => {
  const read = await reader.read([ref(1, 'repo', 'github.evil.example')])
  expect(Object.values(read!.coverage)[0]).toMatchObject({ state: 'unavailable' })
  expect(await reader.read([{ ...ref(1), owner: '../x' }])).toBeNull()
  expect(await reader.read([ref(1), ref(1)])).toBeNull()
  expect(calls).toHaveLength(0)
  gate.trustHost('github.evil.example')
  vi.advanceTimersByTime(61_000) // past the failed attempt's backoff
  replies.push(answer({ p1: raw(1) }))
  await reader.read([ref(1, 'repo', 'github.evil.example')])
  expect(calls[0]).toContain('github.evil.example')
})

it('a rate limit pauses every reader on the gate', async () => {
  replies.push(() => ({ ok: false, reason: 'rate-limited', retryAfterMs: 120_000 }))
  const read = await reader.read([ref(1)])
  expect(read!.coverage[key(1)]?.reason).toBe('rate-limited')
  expect(gate.blocked).toBe(true)
  const other = createGithubPrStatusReader({ gate, cwd: '/' })
  await other.read([ref(2)])
  expect(calls).toHaveLength(1)
})
