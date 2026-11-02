import { afterEach, expect, it, vi } from 'vitest'
import { ghPrsForRepo } from '@phosphor/session-runtime/git/github'
import type { FeatureContext } from '../feature'
import { githubReader } from './github'

vi.mock('@phosphor/session-runtime/git/github', () => ({ ghPrsForRepo: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('shares concurrent reads and caches upstream failures for 60s even when the client asks again', async () => {
  vi.useFakeTimers()
  const id = '1234567890abcdef'
  const context: FeatureContext = {
    store: {
      getLane: () => null,
      listRepositories: () => [{ id, name: 'repo', path: '/host/repo' }],
    },
    env: {},
    home: '/host',
    log: vi.fn(),
  }
  vi.mocked(ghPrsForRepo)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      byBranch: {
        feature: {
          number: 7,
          title: 'Identity only',
          state: 'OPEN',
          url: 'https://github.com/example/repo/pull/7',
          checks: null,
        },
      },
      complete: false,
    })
  const read = githubReader(context)
  expect(await Promise.all([read({ repositoryId: id }), read({ repositoryId: id })])).toEqual([
    { ok: true, data: null },
    { ok: true, data: null },
  ])
  await vi.advanceTimersByTimeAsync(59_999)
  expect(await read({ repositoryId: id })).toEqual({ ok: true, data: null })
  expect(ghPrsForRepo).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await read({ repositoryId: id })).toMatchObject({
    ok: true,
    data: { complete: false, byBranch: { feature: { number: 7, checks: null } } },
  })
  expect(ghPrsForRepo).toHaveBeenCalledTimes(2)
  expect(ghPrsForRepo).toHaveBeenLastCalledWith(expect.any(Function), '/host/repo')
})

it('does not accept local paths or reuse a removed repository identity', async () => {
  const repositories = [{ id: '1234567890abcdef', name: 'repo', path: '/host/repo' }]
  const context: FeatureContext = {
    store: { getLane: () => null, listRepositories: () => repositories },
    env: {},
    home: '/host',
    log: vi.fn(),
  }
  vi.mocked(ghPrsForRepo).mockResolvedValue(null)
  const read = githubReader(context)
  await read({ repositoryId: repositories[0]!.id })
  repositories.length = 0
  expect(await read({ repositoryId: '1234567890abcdef' })).toMatchObject({ ok: false })
  expect(await read({ repositoryId: '/local/repo' })).toMatchObject({ ok: false })
  expect(ghPrsForRepo).toHaveBeenCalledTimes(1)
})
