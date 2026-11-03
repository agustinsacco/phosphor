import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as github from './github'
import { parseRepoPrs } from '@phosphor/shared/host-protocol-github'

const pr = (branch = 'older/lane', number = 42) => ({
  number,
  title: 'Older lane PR',
  url: `https://github.com/example/repo/pull/${number}`,
  state: 'OPEN',
  headRefName: branch,
  headRepository: { nameWithOwner: 'example/repo' },
  mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
})
const ok = (value: unknown) => ({ ok: true as const, stdout: JSON.stringify(value) })
const unavailable = { ok: false as const, reason: 'unavailable' as const }
const run = vi.fn()
let rows = [pr()]
function reply(_cwd: string, args: string[]) {
  if (args[0] === 'repo')
    return ok({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' })
  const query = args.find((arg) => arg.startsWith('query=')) ?? ''
  const data: Record<string, unknown> = {}
  for (const match of query.matchAll(
    /(b\d+|o\d+):pullRequests\(headRefName:("(?:[^"\\]|\\.)*")/g,
  )) {
    const branch = JSON.parse(match[2]!)
    data[match[1]!] = {
      nodes: rows.filter((r) => r.headRefName === branch),
      pageInfo: { hasNextPage: false },
    }
  }
  for (const match of query.matchAll(/(p\d+):pullRequest\(number:(\d+)/g)) {
    data[match[1]!] = rows.find((r) => r.number === Number(match[2])) ?? null
  }
  return ok({ data: { repository: data } })
}
function reader() {
  const create = Reflect.get(github, 'createGithubReader') as (ports: {
    run: typeof run
    origin: () => Promise<string>
    branches: () => Promise<string[]>
    budgetMs?: number
  }) => {
    read: (repo: string, options?: { branches: string[]; force?: boolean }) => Promise<unknown>
  }
  expect(create).toBeTypeOf('function')
  return create({
    run,
    origin: async () => 'https://github.com/example/repo.git',
    branches: async () => rows.map((r) => r.headRefName),
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  rows = [pr()]
  run.mockReset().mockImplementation(reply)
})
afterEach(() => vi.useRealTimers())

it('discovers only requested exact branches and refreshes known canonical PR numbers', async () => {
  const service = reader()
  const first = await service.read('/repo', { branches: ['older/lane'] })
  expect(first).toMatchObject({ byBranch: { 'older/lane': { number: 42 } }, complete: false })
  expect(run.mock.calls.every(([, args]) => args[0] !== 'pr')).toBe(true)
  expect(
    run.mock.calls.some(([, args]) => args.join(' ').includes('headRefName:"older/lane"')),
  ).toBe(true)
  run.mockClear()
  vi.setSystemTime(161_000)
  await service.read('/repo', { branches: ['older/lane'] })
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0]?.[1].join(' ')).toContain('pullRequest(number:42)')
  expect(run.mock.calls[0]?.[1].join(' ')).not.toContain('pullRequests(')
})

it('keeps each page inside the old Host contract even across more than 100 lane branches', async () => {
  rows = Array.from({ length: 101 }, (_, i) => pr(`lane-${i}`, i + 1))
  const service = reader()
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i += 20) {
    const result = parseRepoPrs(
      await service.read('/repo', { branches: rows.slice(i, i + 20).map((r) => r.headRefName) }),
    )
    expect(result).not.toBeNull()
    for (const branch of Object.keys(result!.byBranch)) seen.add(branch)
  }
  expect(seen.size).toBe(101)
})

it('shares in-flight reads and successful cache entries across callers', async () => {
  const service = reader()
  const opts = { branches: ['older/lane'] }
  await Promise.all([service.read('/repo', opts), service.read('/repo', opts)])
  const calls = run.mock.calls.length
  await service.read('/repo', opts)
  expect(run).toHaveBeenCalledTimes(calls)
  expect(calls).toBe(3) // identity, discovery, details
})

it('retains the known PR with unavailable coverage after a failed refresh', async () => {
  const service = reader()
  const opts = { branches: ['older/lane'] }
  await service.read('/repo', opts)
  vi.setSystemTime(161_000)
  run.mockResolvedValue(unavailable)
  expect(await service.read('/repo', opts)).toMatchObject({
    byBranch: { 'older/lane': { number: 42 } },
    coverage: { 'older/lane': { state: 'unavailable', checkedAt: 100_000, attemptedAt: 161_000 } },
    complete: false,
  })
})

it('finishes inside the transport deadline even when the runner never answers', async () => {
  run.mockImplementation(() => new Promise(() => {}))
  const pending = reader().read('/repo', { branches: ['older/lane'] })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await pending).toMatchObject({
    byBranch: {},
    complete: false,
    coverage: { 'older/lane': { state: 'unavailable', reason: 'timeout' } },
  })
})

it('backs off rate-limited reads across repositories, including forced reads', async () => {
  run.mockResolvedValue({ ok: false, reason: 'rate-limited', retryAfterMs: 120_000 })
  const service = reader()
  await service.read('/repo', { branches: ['older/lane'] })
  const calls = run.mock.calls.length
  vi.setSystemTime(161_000)
  expect(await service.read('/other', { branches: ['topic'], force: true })).toMatchObject({
    coverage: { topic: { state: 'unavailable', reason: 'rate-limited' } },
  })
  expect(run).toHaveBeenCalledTimes(calls)
})

it("never attributes another fork's same-named head to this checkout", async () => {
  rows = [{ ...pr(), headRepository: { nameWithOwner: 'someone-else/repo' } }]
  expect(await reader().read('/repo', { branches: ['older/lane'] })).toMatchObject({
    byBranch: {},
    coverage: { 'older/lane': { state: 'absent' } },
    complete: false,
  })
})

it('rejects oversized requests without spawning gh', async () => {
  expect(
    await reader().read('/repo', { branches: Array.from({ length: 21 }, (_, i) => `b${i}`) }),
  ).toBeNull()
  expect(run).not.toHaveBeenCalled()
})
