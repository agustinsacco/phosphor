import type * as fs from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ git: vi.fn(), dirtyCount: vi.fn() }))
vi.mock('@phosphor/session-runtime/git/git-exec', () => ({
  ...mocks,
  abortMergeAndCollectConflicts: vi.fn(),
  gitErrorText: vi.fn(),
}))
vi.mock('./gh-cli', () => ({ ghEvidence: vi.fn() }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  existsSync: () => true,
}))

import { listBranches, listWorktrees } from './git-worktrees'

beforeEach(() => {
  mocks.git.mockReset().mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'worktree')
      return Array.from(
        { length: 100 },
        (_, i) => `worktree /synthetic/${i}\nHEAD abc\nbranch refs/heads/lane-${i}\n`,
      ).join('\n')
    if (args[0] === 'for-each-ref') return 'main\t1\tinitial\n'
    if (args[0] === 'symbolic-ref') return 'origin/main'
    if (args[0] === 'rev-parse') return 'main'
    return ''
  })
  mocks.dirtyCount.mockReset().mockResolvedValue(0)
})

it('bounds dirty reads when listing 100 worktrees instead of spawning one per checkout', async () => {
  let active = 0
  let peak = 0
  mocks.dirtyCount.mockImplementation(async () => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    return 1
  })
  const trees = await listWorktrees('/synthetic')
  expect(trees).toHaveLength(100)
  expect(trees.every((tree) => tree.dirtyCount === 1)).toBe(true)
  expect(peak).toBeLessThanOrEqual(4)
})

it('does not inspect worktree files just to list branches', async () => {
  const result = await listBranches('/synthetic')
  expect(result.branches[0]?.name).toBe('main')
  expect(mocks.dirtyCount).not.toHaveBeenCalled()
})
