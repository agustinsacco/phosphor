import { beforeEach, expect, it, vi } from 'vitest'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import { freshBranchCandidates, prepareCreationFolder } from './create-folder'
import { createRepositoryLocks } from './repository-lock'
import { laneFolderSlug, prepareLaneFolder } from './worktree'
import type * as Worktree from './worktree'

vi.mock('./worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof Worktree>()),
  prepareLaneFolder: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

it('suffixes a fresh branch with -2 to -5, without doubling a trailing separator', () => {
  expect(freshBranchCandidates('feature')).toEqual([
    'feature-2',
    'feature-3',
    'feature-4',
    'feature-5',
  ])
  expect(freshBranchCandidates('fix/login--')).toEqual([
    'fix/login-2',
    'fix/login-3',
    'fix/login-4',
    'fix/login-5',
  ])
})

it('cuts a long base so every candidate still has a worktree folder', () => {
  const long = `team/${'a'.repeat(93)}.b`
  const names = freshBranchCandidates(long)
  expect(names).toHaveLength(4)
  for (const name of names) {
    expect(name.length).toBeLessThanOrEqual(100)
    expect(isLaneBranchName(name)).toBe(true)
    expect(laneFolderSlug(name)).not.toBeNull()
  }
  // The cut lands after the dot, which is stripped rather than kept before the suffix.
  expect(names[0]).toBe(`team/${'a'.repeat(93)}-2`)
})

it('runs the undo of a worktree under the repository lock', async () => {
  const locks = createRepositoryLocks()
  const order: string[] = []
  vi.mocked(prepareLaneFolder).mockResolvedValue({
    cwd: '/repo/one',
    branch: 'one',
    undo: async () => {
      order.push('undo')
    },
  })
  const folder = await prepareCreationFolder({
    root: '/repo',
    worktree: { branch: 'one' },
    locks,
    phase: () => {},
  })
  let release = () => {}
  const busy = locks.run(
    '/repo',
    () =>
      new Promise<void>((resolve) => {
        order.push('other')
        release = resolve
      }),
  )
  const undone = folder.undo()
  await Promise.resolve()
  expect(order).toEqual(['other'])
  release()
  await Promise.all([busy, undone])
  expect(order).toEqual(['other', 'undo'])
})

it('never takes the lock for a lane in place', async () => {
  const locks = createRepositoryLocks()
  const run = vi.spyOn(locks, 'run')
  vi.mocked(prepareLaneFolder).mockResolvedValue({
    cwd: '/repo',
    branch: 'main',
    undo: async () => {},
  })
  const phase = vi.fn()
  await prepareCreationFolder({ root: '/repo', worktree: null, locks, phase })
  expect(run).not.toHaveBeenCalled()
  expect(phase).not.toHaveBeenCalled()
})
