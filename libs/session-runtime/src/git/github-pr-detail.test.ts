import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GithubCommand, GithubCommandResult } from './github-command'
import { GithubGate } from './github-gate'
import { createGithubPrDetailReader, detailQuery, parseDetail } from './github-pr-detail'

const ref = { host: 'github.com', owner: 'Example', repo: 'repo', number: 7 }

const checks = {
  pageInfo: { hasNextPage: false },
  nodes: [
    {
      __typename: 'CheckRun',
      name: 'Rocky review',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      title: '1 unresolved finding',
      detailsUrl: 'https://github.com/Example/repo/runs/1',
      startedAt: '2026-11-13T04:00:00Z',
      completedAt: '2026-11-13T04:06:30Z',
      isRequired: false,
      checkSuite: { workflowRun: { workflow: { name: 'Verified reviews' } } },
      annotations: {
        nodes: [
          {
            path: 'cli/src/run.ts',
            annotationLevel: 'FAILURE',
            message: 'Write commands need an opt-in',
            location: { start: { line: 248 } },
          },
        ],
      },
    },
    {
      __typename: 'StatusContext',
      context: 'deploy/preview',
      state: 'PENDING',
      description: 'Building',
      targetUrl: 'http://insecure.example/x',
      isRequired: false,
    },
  ],
}

/** Trimmed from a real reply: a failing optional review bot and one live thread. */
const pullRequest = (patch: object = {}) => ({
  number: 7,
  reviewThreads: {
    totalCount: 3,
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: 'cli/src/run.ts',
        line: 248,
        comments: {
          totalCount: 2,
          nodes: [
            {
              author: { login: 'rocky' },
              bodyText: '  Preview requests can send live messages  ',
              url: 'https://github.com/Example/repo/pull/7#discussion_r1',
            },
          ],
        },
      },
      { isResolved: true, path: 'a.ts', comments: { totalCount: 1, nodes: [{ bodyText: 'ok' }] } },
      {
        isResolved: false,
        isOutdated: true,
        path: 'api/swagger.json',
        line: null,
        originalLine: 3,
        comments: { totalCount: 1, nodes: [{ author: null, bodyText: 'side note' }] },
      },
    ],
  },
  latestReviews: {
    nodes: [
      { state: 'APPROVED', author: { login: 'nicole' } },
      { state: 'COMMENTED', author: { login: 'darlinton' } },
    ],
  },
  timelineItems: {
    nodes: [
      {
        __typename: 'ReviewRequestedEvent',
        createdAt: '2026-11-13T04:04:44Z',
        actor: { login: 'agustin' },
        requestedReviewer: { __typename: 'Team', slug: 'eng-managers' },
      },
      {
        __typename: 'PullRequestReview',
        state: 'APPROVED',
        submittedAt: '2026-11-10T15:47:26Z',
        author: { login: 'darlinton' },
      },
      {
        __typename: 'PullRequestCommit',
        commit: {
          committedDate: '2026-11-13T03:49:04Z',
          messageHeadline: 'chore: regenerate the CLI',
          author: { user: { login: 'agustin' } },
        },
      },
      { __typename: 'LabeledEvent', createdAt: '2026-11-13T05:00:00Z' },
    ],
  },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: checks } } }] },
  ...patch,
})
const reply = (pr: object | null, errors?: object[]): GithubCommandResult => ({
  ok: true,
  stdout: JSON.stringify({
    data: { repository: { pullRequest: pr } },
    ...(errors ? { errors } : {}),
  }),
})

it('asks for one PR by number, with checks required for that PR and its timeline', () => {
  const query = detailQuery(ref)
  expect(query).toContain('owner:"Example",name:"repo"')
  expect(query).toContain('pullRequest(number:7)')
  expect(query).toContain('isRequired(pullRequestNumber:7)')
  expect(query).toContain('timelineItems(last:20')
})

it('keeps unresolved threads and shapes each check with its workflow and annotations', () => {
  const detail = parseDetail({ data: { repository: { pullRequest: pullRequest() } } }, ref, 5)!
  expect(detail.threads).toEqual([
    {
      path: 'cli/src/run.ts',
      line: 248,
      outdated: false,
      author: 'rocky',
      body: 'Preview requests can send live messages',
      replies: 1,
      url: 'https://github.com/Example/repo/pull/7#discussion_r1',
    },
    { path: 'api/swagger.json', line: 3, outdated: true, body: 'side note', replies: 0 },
  ])
  expect(detail.checks).toEqual([
    {
      name: 'Rocky review',
      state: 'failure',
      required: false,
      title: '1 unresolved finding',
      url: 'https://github.com/Example/repo/runs/1',
      workflow: 'Verified reviews',
      startedAt: '2026-11-13T04:00:00Z',
      completedAt: '2026-11-13T04:06:30Z',
      annotations: [
        {
          path: 'cli/src/run.ts',
          line: 248,
          level: 'failure',
          message: 'Write commands need an opt-in',
        },
      ],
    },
    // Only https links survive.
    {
      name: 'deploy/preview',
      state: 'pending',
      required: false,
      title: 'Building',
      annotations: [],
    },
  ])
  expect(detail).toMatchObject({
    ref,
    commented: ['darlinton'],
    threadsTruncated: false,
    checksTruncated: false,
    checkedAt: 5,
  })
})

it('orders the timeline oldest first and drops kinds it does not know', () => {
  const detail = parseDetail({ data: { repository: { pullRequest: pullRequest() } } }, ref)!
  expect(detail.activity).toEqual([
    { kind: 'review', at: '2026-11-10T15:47:26Z', actor: 'darlinton', state: 'APPROVED' },
    {
      kind: 'commit',
      at: '2026-11-13T03:49:04Z',
      actor: 'agustin',
      text: 'chore: regenerate the CLI',
    },
    { kind: 'requested', at: '2026-11-13T04:04:44Z', actor: 'agustin', text: 'eng-managers' },
  ])
})

it('reads a missing PR as null, and a wrong or empty answer as a failure', () => {
  const missing = { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND' }] }
  expect(parseDetail(missing, ref)).toBeNull()
  expect(() => parseDetail({ data: { repository: { pullRequest: { number: 8 } } } }, ref)).toThrow()
  expect(() => parseDetail({ data: null }, ref)).toThrow()
})

let calls: string[][]
let replies: (GithubCommandResult | undefined)[]
const command: GithubCommand = async (_cwd, args) => {
  calls.push(args)
  return replies.shift() ?? { ok: false, reason: 'unavailable' }
}
let reader: ReturnType<typeof createGithubPrDetailReader>
beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  replies = []
  reader = createGithubPrDetailReader({ gate: new GithubGate(command), cwd: '/' })
})
afterEach(() => vi.useRealTimers())

it('reuses a fresh read, coalesces concurrent ones and respects the forced floor', async () => {
  replies.push(reply(pullRequest()), reply(pullRequest()))
  const [a, b] = await Promise.all([reader.read(ref), reader.read(ref)])
  expect(calls).toHaveLength(1)
  expect(a).toBe(b)
  expect(calls[0]).toEqual(expect.arrayContaining(['--hostname', 'github.com', '--include']))
  await reader.read(ref, { force: true })
  expect(calls).toHaveLength(1)
  vi.advanceTimersByTime(5_000)
  await reader.read(ref, { force: true })
  expect(calls).toHaveLength(2)
})

it('keeps the last detail through a failure and backs off', async () => {
  replies.push(reply(pullRequest()))
  const first = await reader.read(ref)
  vi.advanceTimersByTime(15_000)
  replies.push({ ok: false, reason: 'unavailable' })
  expect(await reader.read(ref)).toEqual(first)
  vi.advanceTimersByTime(30_000)
  expect(await reader.read(ref)).toEqual(first)
  expect(calls).toHaveLength(2)
})

it('refuses bad refs and hosts no checkout resolved, without running gh', async () => {
  expect(await reader.read({ ...ref, number: -1 })).toBeNull()
  expect(await reader.read(ref, { force: 'yes' })).toBeNull()
  expect(await reader.read({ ...ref, host: 'evil.example' })).toBeNull()
  expect(calls).toHaveLength(0)
})
