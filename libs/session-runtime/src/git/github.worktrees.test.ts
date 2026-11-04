import { beforeEach, expect, it, vi } from 'vitest'
import { git } from './git-exec'
import { ghPrsForRepo, type GhRunner } from './github'

vi.mock('./git-exec', () => ({ git: vi.fn() }))

const recent = Array.from({ length: 100 }, (_, i) => ({
  number: 19700 - i,
  url: `https://github.com/example/service/pull/${19700 - i}`,
  headRefName: `team/recent-${i}`,
  state: 'OPEN',
}))
const older = {
  number: 19499,
  url: 'https://github.com/example/service/pull/19499',
  headRefName: 'agustin/notification-service-alert-review',
  state: 'OPEN',
}
const worktrees = (...branches: string[]) =>
  branches.map((branch) => `worktree /repo/${branch}\0branch refs/heads/${branch}\0\0`).join('')

beforeEach(() => {
  vi.mocked(git).mockReset().mockResolvedValue(worktrees('main', older.headRefName))
})

it('finds a checked-out lane PR older than the newest 100 repository PRs', async () => {
  const gh = vi.fn<GhRunner>(async (_cwd, args) =>
    JSON.stringify(args.includes('--search') ? [older] : recent),
  )
  const result = await ghPrsForRepo(gh, '/repo')
  expect(result?.byBranch[older.headRefName]?.number).toBe(19499)
  expect(result?.byBranch['team/recent-0']?.number).toBe(19700)
  expect(result?.complete).toBe(false)
  expect(git).toHaveBeenCalledWith('/repo', ['worktree', 'list', '--porcelain', '-z'], {
    isolateEnv: true,
    maxBuffer: 1024 * 1024,
  })
  expect(gh).toHaveBeenCalledTimes(2)
  expect(gh.mock.calls[1]?.[0]).toBe('/repo')
  expect(gh.mock.calls[1]?.[1]).toEqual(
    expect.arrayContaining(['--search', `head:"main" head:"${older.headRefName}"`]),
  )
})

it('keeps unavailable check details honest on the targeted fallback too', async () => {
  const gh = vi.fn<GhRunner>(async (_cwd, args) => {
    if (!args.includes('--search')) return JSON.stringify(recent)
    return args.at(-1)?.includes('statusCheckRollup') ? null : JSON.stringify([older])
  })
  const result = await ghPrsForRepo(gh, '/repo')
  expect(result?.byBranch[older.headRefName]).toMatchObject({ number: 19499, checks: null })
  expect(gh).toHaveBeenCalledTimes(3)
})

it('does not spend extra git or GitHub reads on a complete repository listing', async () => {
  const gh = vi.fn<GhRunner>(async () => JSON.stringify([older]))
  expect((await ghPrsForRepo(gh, '/repo'))?.complete).toBe(true)
  expect(git).not.toHaveBeenCalled()
  expect(gh).toHaveBeenCalledTimes(1)
})

it('retains the recent listing when worktree discovery fails', async () => {
  vi.mocked(git).mockRejectedValue(new Error('git unavailable'))
  const gh = vi.fn<GhRunner>(async () => JSON.stringify(recent))
  expect((await ghPrsForRepo(gh, '/repo'))?.byBranch['team/recent-0']?.number).toBe(19700)
  expect(gh).toHaveBeenCalledTimes(1)
})

it('retains the recent listing and never infers absence when targeted queries fail', async () => {
  const gh = vi.fn<GhRunner>(async (_cwd, args) =>
    args.includes('--search') ? null : JSON.stringify(recent),
  )
  const result = await ghPrsForRepo(gh, '/repo')
  expect(result?.byBranch['team/recent-0']?.number).toBe(19700)
  expect(result?.complete).toBe(false)
})

it('batches missing branches, deduplicates them and skips detached or already-known heads', async () => {
  const branches = Array.from({ length: 25 }, (_, i) => `team/older-${i}`)
  vi.mocked(git).mockResolvedValue(
    worktrees(...branches, branches[0]!, 'team/recent-0') + 'worktree /detached\0detached\0\0',
  )
  const gh = vi.fn<GhRunner>(async (_cwd, args) =>
    JSON.stringify(args.includes('--search') ? [] : recent),
  )
  await ghPrsForRepo(gh, '/repo')
  const searches = gh.mock.calls.filter(([, args]) => args.includes('--search'))
  expect(searches).toHaveLength(2)
  const query = searches.map(([, args]) => args[args.indexOf('--search') + 1]).join(' ')
  for (const branch of branches) expect(query.split(`head:"${branch}"`)).toHaveLength(2)
  expect(query).not.toContain('team/recent-0')
  expect(query).not.toContain('detached')
})

it('quotes unusual branch names and bounds long search batches', async () => {
  const unusual = 'team/literal"label:injected'
  const branches = Array.from({ length: 15 }, (_, i) => `team/${'long'.repeat(95)}-${i}`)
  vi.mocked(git).mockResolvedValue(worktrees(unusual, ...branches))
  const gh = vi.fn<GhRunner>(async (_cwd, args) =>
    JSON.stringify(args.includes('--search') ? [] : recent),
  )
  await ghPrsForRepo(gh, '/repo')
  const searches = gh.mock.calls
    .filter(([, args]) => args.includes('--search'))
    .map(([, args]) => args[args.indexOf('--search') + 1]!)
  expect(searches).toHaveLength(2)
  expect(searches[0]).toContain(`head:${JSON.stringify(unusual)}`)
  for (const search of searches) expect(search.length).toBeLessThanOrEqual(4000)
})

it('finds merged PRs for the main checkout as well as worktree PRs', async () => {
  const merged = { ...older, headRefName: 'main', number: 15776, state: 'MERGED' }
  const gh = vi.fn<GhRunner>(async (_cwd, args) =>
    JSON.stringify(args.includes('--search') ? [merged] : recent),
  )
  const result = await ghPrsForRepo(gh, '/repo')
  expect(result?.byBranch.main).toMatchObject({ number: 15776, state: 'MERGED' })
  expect(result?.complete).toBe(false)
})
