import { expect, it, vi } from 'vitest'
import { createGitFeature } from '../git'
import { ghPrsForRepo } from '@phosphor/session-runtime/git/github'
import type { FeatureContext } from '../feature'

vi.mock('@phosphor/session-runtime/git/github', () => ({ ghPrsForRepo: vi.fn() }))
const repositoryId = '1234567890abcdef'
const context: FeatureContext = {
  store: {
    getLane: () => null,
    listRepositories: () => [{ id: repositoryId, name: 'repo', path: '/host/repo' }],
  },
  env: { PATH: '/host/bin' },
  home: '/host',
  log: vi.fn(),
}
it('batches reads per configured repository, caches failures, and refuses caller paths', async () => {
  vi.mocked(ghPrsForRepo).mockResolvedValue(null)
  const feature = createGitFeature(context)
  expect(feature.methods).toContain('github.prs')
  expect(await feature.call('github.prs', { repositoryId, path: '/elsewhere' })).toMatchObject({
    ok: false,
  })
  expect(await feature.call('github.prs', { repositoryId: '0000000000000000' })).toMatchObject({
    ok: false,
  })
  expect(ghPrsForRepo).not.toHaveBeenCalled()
  expect(await feature.call('github.prs', { repositoryId })).toEqual({ ok: true, data: null })
  await feature.call('github.prs', { repositoryId })
  expect(ghPrsForRepo).toHaveBeenCalledTimes(1)
  expect(ghPrsForRepo).toHaveBeenCalledWith(expect.any(Function), '/host/repo')
})
