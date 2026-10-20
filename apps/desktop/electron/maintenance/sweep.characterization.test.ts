import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeInfo } from '@shared/models'
import { DEFAULT_MAINTENANCE_PREFS } from '@shared/models'
import type { git } from '@phosphor/session-runtime/git/git-exec'
import type { listWorktrees, pruneWorktrees, removeWorktree } from '../fs/git-worktrees'
import { sweep, type SweepOptions } from './sweep'

const ports = vi.hoisted(() => ({
  git: vi.fn<typeof git>(),
  list: vi.fn<typeof listWorktrees>(),
  prune: vi.fn<typeof pruneWorktrees>(),
  remove: vi.fn<typeof removeWorktree>(),
  merged: vi.fn(async () => true),
  landed: vi.fn(async () => false),
  measure: vi.fn(async (_command: string, args: string[]) => ({
    stdout: `${args[1] === '/repo/first' ? 3 : 7}\t${args[1]}\n`,
    stderr: '',
  })),
  log: vi.fn(),
}))
vi.mock('@phosphor/session-runtime/git/git-exec', () => ({ git: ports.git }))
vi.mock('../fs/git-worktrees', () => ({
  listWorktrees: ports.list,
  pruneWorktrees: ports.prune,
  removeWorktree: ports.remove,
  isBranchMerged: ports.merged,
  landedViaPullRequest: ports.landed,
}))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: ports.measure }) }
})
vi.mock('node:fs/promises', () => ({ stat: async () => ({ mtimeMs: 0 }) }))
vi.mock('../pi/pi-paths', () => ({ sessionDirForCwd: (path: string) => `${path}/sessions` }))
vi.mock('../debug-log', () => ({ log: ports.log }))
// Preserve the frozen orchestration observations with an explicitly eligible conversation port.
vi.mock('./conversations', () => ({
  conversationFacts: async () => ({ completedAtMs: 1, lastWriteMs: 0, pinned: false }),
}))
vi.mock('./removal', () => ({
  removeCompletedWorktree: (repo: string, path: string) =>
    ports.remove(repo, path, { deleteBranch: true }),
}))

const options: SweepOptions = {
  repoPath: '/repo',
  prefs: DEFAULT_MAINTENANCE_PREFS,
  protectedPaths: [],
  liveSessionCount: 2,
  act: true,
  now: 72 * 60 * 60 * 1000,
}

function lane(name: string): WorktreeInfo {
  return {
    path: `/repo/${name}`,
    realPath: `/repo/${name}`,
    branch: name,
    head: 'abc',
    isMain: false,
    dirtyCount: 0,
    locked: false,
    prunable: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ports.git.mockResolvedValue('true')
  ports.list.mockResolvedValue([lane('first'), lane('second')])
  ports.prune.mockResolvedValue({ pruned: ['stale registration'] })
  ports.remove.mockResolvedValue({ removed: true, branchDeleted: true })
  ports.merged.mockResolvedValue(true)
})

describe('sweep characterization', () => {
  it('returns the initialized report for a nonrepo without pruning or scanning', async () => {
    ports.git.mockResolvedValue('false')

    expect(await sweep(options)).toEqual({
      ranAt: options.now,
      workspacePath: '/repo',
      worktreeCount: 0,
      candidates: [],
      held: [],
      prunedRegistrations: [],
      reclaimed: [],
      reclaimableBytes: 0,
      reclaimedBytes: 0,
      liveSessionCount: 2,
      errors: [],
    })
    expect(ports.git).toHaveBeenCalledWith('/repo', ['rev-parse', '--is-inside-work-tree'], {
      allowFail: true,
      trim: true,
    })
    expect(ports.prune).not.toHaveBeenCalled()
    expect(ports.list).not.toHaveBeenCalled()
    expect(ports.remove).not.toHaveBeenCalled()
    expect(ports.log).not.toHaveBeenCalled()
  })

  it('retains a prune error while scanning and reclaiming candidates', async () => {
    ports.prune.mockRejectedValueOnce(new Error('prune failed'))

    const report = await sweep(options)

    expect(report.errors).toEqual(['prune: Error: prune failed'])
    expect(report.prunedRegistrations).toEqual([])
    expect(report.reclaimed.map((candidate) => candidate.path)).toEqual([
      '/repo/first',
      '/repo/second',
    ])
    expect(ports.prune.mock.invocationCallOrder[0]).toBeLessThan(
      ports.list.mock.invocationCallOrder[0]!,
    )
  })

  it('returns a partial report including pruning when the scan fails', async () => {
    ports.list.mockRejectedValueOnce(new Error('scan failed'))

    const report = await sweep(options)

    expect(report).toEqual({
      ranAt: options.now,
      workspacePath: '/repo',
      worktreeCount: 0,
      candidates: [],
      held: [],
      prunedRegistrations: ['stale registration'],
      reclaimed: [],
      reclaimableBytes: 0,
      reclaimedBytes: 0,
      liveSessionCount: 2,
      errors: ['scan: Error: scan failed'],
    })
    expect(ports.remove).not.toHaveBeenCalled()
    expect(ports.log).not.toHaveBeenCalled()
  })

  it('prunes and measures in a dry run without removal or completion logging', async () => {
    const report = await sweep({ ...options, act: false })

    expect(report.worktreeCount).toBe(2)
    expect(report.prunedRegistrations).toEqual(['stale registration'])
    expect(report.candidates).toEqual([
      { path: '/repo/first', branch: 'first', bytes: 3072, reason: 'merged' },
      { path: '/repo/second', branch: 'second', bytes: 7168, reason: 'merged' },
    ])
    expect(report.reclaimableBytes).toBe(10240)
    expect(report.reclaimedBytes).toBe(0)
    expect(report.reclaimed).toEqual([])
    expect(report.errors).toEqual([])
    expect(ports.remove).not.toHaveBeenCalled()
    expect(ports.log).not.toHaveBeenCalled()
  })

  it('preserves a candidate that became dirty and continues without forcing removal', async () => {
    ports.remove.mockResolvedValueOnce({ removed: false, dirtyCount: 3 })

    const report = await sweep(options)

    expect(report.errors).toEqual(['/repo/first: became dirty (3)'])
    expect(report.reclaimed).toEqual([{ path: '/repo/second', branch: 'second', bytes: 7168 }])
    expect(report.reclaimedBytes).toBe(7168)
    expect(report.reclaimableBytes).toBe(10240)
    expect(ports.remove.mock.calls).toEqual([
      ['/repo', '/repo/first', { deleteBranch: true }],
      ['/repo', '/repo/second', { deleteBranch: true }],
    ])
  })

  it('retains per-candidate errors and continues with later removals', async () => {
    ports.remove.mockRejectedValueOnce(new Error('remove failed'))
    ports.remove.mockResolvedValueOnce({
      removed: true,
      branchDeleted: false,
      branchError: 'branch locked',
    })

    const report = await sweep(options)

    expect(report.errors).toEqual(['/repo/first: Error: remove failed', 'second: branch locked'])
    expect(report.reclaimed).toEqual([{ path: '/repo/second', branch: 'second', bytes: 7168 }])
    expect(report.reclaimedBytes).toBe(7168)
    expect(ports.log).toHaveBeenCalledWith('maintenance', 'sweep complete', {
      repoPath: '/repo',
      worktrees: 2,
      candidates: 2,
      reclaimed: 1,
      reclaimedBytes: 7168,
      errors: 2,
    })
  })

  it('awaits each destructive candidate before starting the next and totals exact bytes', async () => {
    let finishFirst!: (result: Awaited<ReturnType<typeof removeWorktree>>) => void
    ports.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    const pending = sweep(options)
    await vi.waitFor(() => expect(ports.remove).toHaveBeenCalledTimes(1))
    expect(ports.remove).toHaveBeenCalledWith('/repo', '/repo/first', { deleteBranch: true })
    finishFirst({ removed: true, branchDeleted: true })
    const report = await pending

    expect(ports.remove).toHaveBeenCalledTimes(2)
    expect(report.reclaimed).toEqual([
      { path: '/repo/first', branch: 'first', bytes: 3072 },
      { path: '/repo/second', branch: 'second', bytes: 7168 },
    ])
    expect(report.reclaimedBytes).toBe(10240)
    expect(report.reclaimableBytes).toBe(10240)
    expect(report.errors).toEqual([])
  })
})
