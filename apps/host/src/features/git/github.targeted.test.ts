import { beforeEach, expect, it, vi } from 'vitest'
import type { FeatureContext } from '../feature'
const { read, remove, factory } = vi.hoisted(() => {
  const read = vi.fn(),
    remove = vi.fn()
  return { read, remove, factory: vi.fn(() => ({ read, remove })) }
})
vi.mock('@phosphor/session-runtime/git/github-reader', () => ({ createGithubReader: factory }))
import { githubReader } from './github'

const id = '1234567890abcdef'
const repositories = [{ id, path: '/host/repo' }]
const listRepositories = vi.fn(() => repositories)
const context = {
  store: { listRepositories },
  env: { PATH: '/host/bin' },
} as unknown as FeatureContext
beforeEach(() => {
  vi.clearAllMocks()
  listRepositories.mockReturnValue(repositories)
  read.mockResolvedValue({
    byBranch: {},
    complete: false,
    coverage: { lane: { state: 'absent', checkedAt: 10, attemptedAt: 10 } },
  })
})

it('forwards validated interests and preserves upstream coverage within the old response cap', async () => {
  const query = githubReader(context)
  const options = { branches: ['lane'], force: true }
  expect(await query({ repositoryId: id, options })).toEqual({
    ok: true,
    data: await read.mock.results[0]!.value,
  })
  expect(read).toHaveBeenCalledWith('/host/repo', options)
  expect(factory).toHaveBeenCalledTimes(1)
})

it('rejects caller paths, unknown repositories and oversized interests before doing GitHub work', async () => {
  const query = githubReader(context)
  for (const params of [
    { repositoryId: '/host/repo', options: { branches: ['lane'] } },
    { repositoryId: id, path: '/private', options: { branches: ['lane'] } },
    { repositoryId: id, options: { branches: Array.from({ length: 21 }, (_, i) => `b${i}`) } },
  ])
    expect(await query(params)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  expect(read).not.toHaveBeenCalled()
})

it('removes cached repositories when configuration is withdrawn', async () => {
  const query = githubReader(context)
  await query({ repositoryId: id, options: { branches: ['lane'] } })
  listRepositories.mockReturnValue([])
  expect(await query({ repositoryId: id, options: { branches: ['lane'] } })).toMatchObject({
    ok: false,
  })
  expect(remove).toHaveBeenCalledWith('/host/repo')
})
