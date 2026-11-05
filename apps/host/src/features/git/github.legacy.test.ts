import { expect, it, vi } from 'vitest'
import type { FeatureContext } from '../feature'
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: exec }))
import { githubReader } from './github'

it('keeps a nonempty legacy PR listing across the actual Host command adapter', async () => {
  exec.mockImplementation((_file, _args, _opts, cb) =>
    cb(null, {
      stdout: JSON.stringify([
        {
          headRefName: 'lane',
          number: 42,
          title: 'Old client',
          state: 'OPEN',
          url: 'https://github.com/org/repo/pull/42',
        },
      ]),
      stderr: '',
    }),
  )
  const repositoryId = '1234567890abcdef'
  const context = {
    store: { listRepositories: () => [{ id: repositoryId, path: '/host/repo' }] },
    env: {},
  } as unknown as FeatureContext
  expect(await githubReader(context)({ repositoryId })).toMatchObject({
    ok: true,
    data: { byBranch: { lane: { number: 42 } }, complete: true },
  })
  expect(exec).toHaveBeenCalledTimes(1)
})
