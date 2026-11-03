import { describe, expect, it, vi } from 'vitest'
import {
  baseRuns,
  mergeArgs,
  originPolicy,
  parsePolicy,
  queueChanges,
  queueLines,
  readQueue,
  rollup,
} from './release-github'

const sha = (c: string) => c.repeat(40)
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  headRefOid: sha(String(number % 10)),
  isDraft: false,
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  labels: [] as Array<{ name: string }>,
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...extra,
})

describe('release policy', () => {
  it('reads base and merge from front matter, defaulting to main and squash', () => {
    expect(parsePolicy('---\nbase: develop\nmerge: merge\nvalidate: npm test\n---\nBody')).toEqual({
      base: 'develop',
      merge: 'merge',
    })
    expect(parsePolicy("---\nbase: 'release/1.x' # comment\n---")).toEqual({
      base: 'release/1.x',
      merge: 'squash',
    })
    expect(parsePolicy('no front matter\nbase: other')).toEqual({ base: 'main', merge: 'squash' })
  })

  it('never lets the base become an option or the merge an unknown flag', () => {
    expect(parsePolicy('---\nbase: --upload-pack=evil\nmerge: admin\n---')).toEqual({
      base: 'main',
      merge: 'squash',
    })
  })

  it("reads the policy from origin's base branch", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === 'show' ? '---\nmerge: rebase\n---' : '',
    )
    expect(await originPolicy(git, 'main')).toEqual({ base: 'main', merge: 'rebase' })
    expect(git.mock.calls[1]?.[0]).toEqual([
      'show',
      'refs/remotes/origin/main:.github/release-manager.md',
    ])
    git.mockImplementation(async (args) => {
      if (args[0] === 'show') throw new Error('missing')
      return ''
    })
    await expect(originPolicy(git, 'main')).rejects.toThrow(/release-setup/)
  })
})

describe('queue digest', () => {
  it('rolls checks up coarsely', () => {
    expect(rollup(null)).toBe('none')
    expect(rollup([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(rollup([{ status: 'QUEUED' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe(
      'pending',
    )
    expect(rollup([{ state: 'PENDING' }])).toBe('pending')
    expect(rollup([{ status: 'IN_PROGRESS' }, { conclusion: 'TIMED_OUT' }])).toBe('failing')
    expect(rollup([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }])).toBe(
      'passing',
    )
  })

  it('writes one line per fact a pass acts on, ignoring other labels', () => {
    const lines = queueLines(
      [
        pr(12, { labels: [{ name: 'bug' }, { name: 'rm:priority' }] }),
        pr(3, { isDraft: true, mergeable: 'UNKNOWN', statusCheckRollup: null }),
        pr(7, { baseRefName: 'agustin/stack', mergeable: 'CONFLICTING' }),
      ],
      'main',
      sha('a'),
      'CI: passing',
    )
    expect(lines).toEqual([
      'main aaaaaaa CI: passing',
      '#3 3333333 draft checks none',
      '#7 7777777 onto agustin/stack ready conflicting checks passing',
      '#12 2222222 ready checks passing rm:priority',
    ])
  })

  it("summarizes each workflow's latest run on the base head", () => {
    const runs = [
      { headSha: sha('a'), workflowName: 'CI', status: 'IN_PROGRESS', conclusion: null },
      { headSha: sha('a'), workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { headSha: sha('a'), workflowName: 'Deploy', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { headSha: sha('b'), workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]
    expect(baseRuns(runs, sha('a'))).toBe('CI: pending, Deploy: passing')
    expect(baseRuns(runs, sha('c'))).toBe('')
  })

  it('lists additions before removals', () => {
    expect(queueChanges(['a', 'b'], ['b', 'c'])).toEqual(['+ c', '- a'])
    expect(queueChanges(['a'], ['a'])).toEqual([])
  })

  it('says when the open pull requests may not all be listed', async () => {
    const open = Array.from({ length: 100 }, (_, i) => pr(i + 1))
    const gh = vi.fn(async (args: string[]) => (args[0] === 'pr' ? JSON.stringify(open) : '[]'))
    const git = vi.fn(async () => `${sha('a')}\trefs/heads/main\n`)
    const more = 'Only the first 100 open pull requests are listed: read the rest with gh pr list.'
    expect((await readQueue(gh, git, 'main')).lines).toContain(more)
    open.pop()
    expect((await readQueue(gh, git, 'main')).lines).not.toContain(more)
  })

  it('reads pull requests, base CI and the base head, and says when a sweep could help', async () => {
    const open = [pr(1, { isDraft: true }), pr(2, { labels: [{ name: 'rm:hold' }] })]
    const gh = vi.fn(async (args: string[]) =>
      args[0] === 'pr'
        ? JSON.stringify(open)
        : JSON.stringify([{ headSha: sha('a'), status: 'COMPLETED', conclusion: 'SUCCESS' }]),
    )
    const git = vi.fn(async () => `${sha('a')}\trefs/heads/main\n`)
    const idle = await readQueue(gh, git, 'main')
    expect(idle.lines[0]).toBe('main aaaaaaa CI: passing')
    expect(idle.actionable).toBe(false)
    open.push(pr(4))
    expect((await readQueue(gh, git, 'main')).actionable).toBe(true)
    open[2] = pr(4, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] })
    expect((await readQueue(gh, git, 'main')).actionable).toBe(false)
  })
})

describe('merging', () => {
  it('pins the reviewed head with the policy merge method', () => {
    expect(mergeArgs(12, sha('a'), { base: 'main', merge: 'squash' })).toEqual([
      'pr',
      'merge',
      '12',
      '--squash',
      '--match-head-commit',
      sha('a'),
    ])
  })
})
