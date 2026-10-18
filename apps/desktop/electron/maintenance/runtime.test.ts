import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAINTENANCE_PREFS, type MaintenanceReport } from '@shared/models'
import type { SweepOptions } from './sweep'
import { WARMUP_MS } from './scheduler'

const state = vi.hoisted(() => ({
  getPrefs: vi.fn(),
  list: vi.fn(),
  routinePaths: vi.fn(),
  sweep: vi.fn<(options: SweepOptions) => Promise<MaintenanceReport>>(),
  log: vi.fn(),
}))

vi.mock('../store', () => ({ getPrefs: state.getPrefs }))
vi.mock('../registry', () => ({ registry: { list: state.list } }))
vi.mock('../routines', () => ({ routineProtectedPaths: state.routinePaths }))
vi.mock('../fs/git-worktrees', () => ({ normalizeRealPath: (path: string) => path }))
vi.mock('./sweep', () => ({ sweep: state.sweep }))
vi.mock('../debug-log', () => ({ log: state.log }))

function report(path: string, errors: string[] = []): MaintenanceReport {
  return {
    ranAt: 0,
    workspacePath: path,
    worktreeCount: 0,
    candidates: [],
    held: [],
    prunedRegistrations: [],
    reclaimed: [],
    reclaimableBytes: 0,
    reclaimedBytes: 0,
    liveSessionCount: 0,
    errors,
  }
}

function repos(...paths: string[]): void {
  state.getPrefs.mockReturnValue({
    maintenance: { ...DEFAULT_MAINTENANCE_PREFS },
    recentWorkspaces: paths.map((path) => ({ path })),
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  repos('/a', '/b')
  state.list.mockReturnValue([{ workspacePath: '/live-only' }])
  state.routinePaths.mockReturnValue(['/routine-only'])
  state.sweep.mockImplementation(async ({ repoPath }) => report(repoPath))
})

afterEach(() => vi.useRealTimers())

describe('maintenance runtime', () => {
  it('selects only unique recent repositories in preference order and refreshes them per run', async () => {
    const { runAll } = await import('./runtime')
    repos('/b', '/a', '/b')
    expect(await runAll(false)).toEqual([report('/b'), report('/a')])
    expect(state.sweep.mock.calls.map(([options]) => options.repoPath)).toEqual(['/b', '/a'])
    state.sweep.mockClear()
    repos('/new')
    expect(await runAll(true)).toEqual([report('/new')])
    expect(state.sweep).toHaveBeenCalledOnce()
    repos()
    expect(await runAll(false)).toEqual([])
    expect(state.sweep).toHaveBeenCalledOnce()
  })

  it('awaits each sweep before the next and preserves error reports without stopping', async () => {
    const { runAll } = await import('./runtime')
    const first = report('/a', ['scan: failed'])
    const second = report('/b')
    let release!: (value: MaintenanceReport) => void
    state.sweep.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    state.sweep.mockResolvedValueOnce(second)
    const running = runAll(false)
    expect(state.sweep.mock.calls.map(([options]) => options.repoPath)).toEqual(['/a'])
    release(first)
    const reports = await running
    expect(reports).toEqual([first, second])
    expect(reports[0]).toBe(first)
    expect(reports[1]).toBe(second)
    expect(state.sweep.mock.calls.map(([options]) => options.repoPath)).toEqual(['/a', '/b'])
  })

  it('propagates an unexpected sweep rejection without attempting later explicit repositories', async () => {
    const { runAll } = await import('./runtime')
    state.sweep.mockRejectedValueOnce(new Error('unexpected failure'))
    await expect(runAll(true)).rejects.toThrow('unexpected failure')
    expect(state.sweep).toHaveBeenCalledOnce()
  })

  it('constructs the singleton at import without starting it or reading prefs', async () => {
    const { maintenanceScheduler } = await import('./runtime')
    expect(state.getPrefs).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    maintenanceScheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    await maintenanceScheduler.tick(1000 + WARMUP_MS - 1)
    expect(state.sweep).not.toHaveBeenCalled()
    maintenanceScheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses current scheduler preferences and continues after a rejected scheduled sweep', async () => {
    const { maintenanceScheduler } = await import('./runtime')
    const prefs = { ...DEFAULT_MAINTENANCE_PREFS, reclaimMergedWorktrees: true }
    state.getPrefs.mockReturnValue({
      maintenance: prefs,
      recentWorkspaces: [{ path: '/a' }, { path: '/b' }],
    })
    state.sweep.mockRejectedValueOnce(new Error('unavailable'))
    await maintenanceScheduler.tick(1000 + WARMUP_MS)
    expect(
      state.sweep.mock.calls.map(([options]) => [options.repoPath, options.act, options.prefs]),
    ).toEqual([
      ['/a', true, prefs],
      ['/b', true, prefs],
    ])
    expect(maintenanceScheduler.reports()).toEqual([report('/b')])
    expect(state.log).toHaveBeenCalledWith('maintenance', 'sweep failed', {
      repoPath: '/a',
      error: 'Error: unavailable',
    })
  })
})
