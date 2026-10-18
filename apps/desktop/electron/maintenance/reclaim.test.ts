import { describe, expect, it, vi } from 'vitest'
import type { ReclaimCandidate } from '@shared/models'
import type { removeWorktree } from '../fs/git-worktrees'
import { initializeReport, reclaimCandidates } from './reclaim'

function candidate(name: string, bytes: number | null): ReclaimCandidate {
  return { path: `/repo/${name}`, branch: name, bytes, reason: 'merged' }
}

describe('initializeReport', () => {
  it('initializes all report fields with independent collections', () => {
    const report = initializeReport('/repo', 123, 2)
    expect(report).toEqual({
      ranAt: 123,
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
    const next = initializeReport('/other', 456, 0)
    for (const key of [
      'candidates',
      'held',
      'prunedRegistrations',
      'reclaimed',
      'errors',
    ] as const) {
      expect(report[key]).not.toBe(next[key])
    }
  })
})

describe('reclaimCandidates', () => {
  it('records a dirty refusal without retrying or forcing, then continues', async () => {
    const report = initializeReport('/repo', 123, 0)
    report.candidates = [candidate('dirty', 50), candidate('clean', 100)]
    const remove = vi.fn<typeof removeWorktree>()
    remove.mockResolvedValueOnce({ removed: false, dirtyCount: 4 })
    remove.mockResolvedValueOnce({ removed: true, branchDeleted: true })

    await reclaimCandidates(report, remove)

    expect(remove.mock.calls).toEqual([
      ['/repo', '/repo/dirty', { deleteBranch: true }],
      ['/repo', '/repo/clean', { deleteBranch: true }],
    ])
    expect(report.errors).toEqual(['/repo/dirty: became dirty (4)'])
    expect(report.reclaimed).toEqual([{ path: '/repo/clean', branch: 'clean', bytes: 100 }])
    expect(report.reclaimedBytes).toBe(100)
  })

  it('retains prior errors, branch deletion errors and thrown removals while continuing', async () => {
    const report = initializeReport('/repo', 123, 0)
    report.errors.push('prune: previous error')
    report.candidates = [candidate('locked', 50), candidate('failed', 500), candidate('last', null)]
    const remove = vi.fn<typeof removeWorktree>()
    remove.mockResolvedValueOnce({
      removed: true,
      branchDeleted: false,
      branchError: 'branch locked',
    })
    remove.mockRejectedValueOnce(new Error('cannot remove'))
    remove.mockResolvedValueOnce({ removed: true, branchDeleted: true })

    await reclaimCandidates(report, remove)

    expect(remove).toHaveBeenCalledTimes(3)
    expect(report.errors).toEqual([
      'prune: previous error',
      'locked: branch locked',
      '/repo/failed: Error: cannot remove',
    ])
    expect(report.reclaimed).toEqual([
      { path: '/repo/locked', branch: 'locked', bytes: 50 },
      { path: '/repo/last', branch: 'last', bytes: null },
    ])
    expect(report.reclaimedBytes).toBe(50)
  })

  it('waits for each removal to finish before starting another', async () => {
    const report = initializeReport('/repo', 123, 0)
    report.candidates = [candidate('first', 20), candidate('second', 30)]
    let finishFirst!: (result: Awaited<ReturnType<typeof removeWorktree>>) => void
    const remove = vi.fn<typeof removeWorktree>()
    remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    remove.mockResolvedValueOnce({ removed: true, branchDeleted: true })

    const pending = reclaimCandidates(report, remove)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(report.reclaimed).toEqual([])
    finishFirst({ removed: true, branchDeleted: true })
    await pending

    expect(remove.mock.calls.map(([, path]) => path)).toEqual(['/repo/first', '/repo/second'])
    expect(report.reclaimedBytes).toBe(50)
  })

  it('leaves an empty candidate report untouched', async () => {
    const report = initializeReport('/repo', 123, 0)
    const before = structuredClone(report)
    const remove = vi.fn<typeof removeWorktree>()

    await reclaimCandidates(report, remove)

    expect(report).toEqual(before)
    expect(remove).not.toHaveBeenCalled()
  })
})
