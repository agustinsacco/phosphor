import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAINTENANCE_PREFS, type MaintenanceReport } from '@shared/models'
import { MaintenanceScheduler, MIN_INTERVAL_MINUTES, WARMUP_MS } from './scheduler'

function report(repoPath: string): MaintenanceReport {
  return {
    ranAt: 0,
    workspacePath: repoPath,
    worktreeCount: 1,
    candidates: [],
    held: [],
    prunedRegistrations: [],
    reclaimed: [],
    reclaimableBytes: 0,
    reclaimedBytes: 0,
    liveSessionCount: 0,
    errors: [],
  }
}

function make() {
  const runSweep = vi.fn(async (repoPath: string) => report(repoPath))
  const scheduler = new MaintenanceScheduler({
    getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
    getRepoPaths: () => ['/repo'],
    runSweep,
  })
  return { scheduler, runSweep }
}

/** Evaluated per call: each scheduler stamps its own `startedAt` at construction. */
const pastWarmup = (): number => Date.now() + WARMUP_MS + 1000

describe('MaintenanceScheduler', () => {
  it('sweeps every repo once past warmup', async () => {
    const runSweep = vi.fn(async (repoPath: string) => report(repoPath))
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => ['/a', '/b'],
      runSweep,
    })
    await scheduler.tick(pastWarmup())
    expect(runSweep.mock.calls.map((c) => c[0])).toEqual(['/a', '/b'])
  })

  it('does nothing during warmup, when launch is busiest', async () => {
    const { scheduler, runSweep } = make()
    await scheduler.tick(Date.now())
    expect(runSweep).not.toHaveBeenCalled()
  })

  it('does nothing while disabled', async () => {
    const runSweep = vi.fn(async (repoPath: string) => report(repoPath))
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => ({ ...DEFAULT_MAINTENANCE_PREFS, enabled: false }),
      getRepoPaths: () => ['/repo'],
      runSweep,
    })
    await scheduler.tick(pastWarmup())
    expect(runSweep).not.toHaveBeenCalled()
  })

  it('never runs two sweeps at once', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const runSweep = vi.fn(async (repoPath: string) => {
      await gate
      return report(repoPath)
    })
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => ['/repo'],
      runSweep,
    })
    const first = scheduler.tick(pastWarmup())
    await scheduler.tick(pastWarmup())
    expect(runSweep).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('keeps sweeping after one repo throws', async () => {
    const runSweep = vi.fn(async (repoPath: string) => {
      if (repoPath === '/a') throw new Error('boom')
      return report(repoPath)
    })
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => ['/a', '/b'],
      runSweep,
    })
    await scheduler.tick(pastWarmup())
    expect(scheduler.reports().map((r) => r.workspacePath)).toEqual(['/b'])
  })

  it('clears the running flag after a failure, so the next tick still sweeps', async () => {
    const runSweep = vi.fn(async () => {
      throw new Error('boom')
    })
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => ['/repo'],
      runSweep,
    })
    await scheduler.tick(pastWarmup())
    await scheduler.tick(pastWarmup())
    expect(runSweep).toHaveBeenCalledTimes(2)
  })

  it('clamps a too-short interval to the floor', () => {
    const timers: number[] = []
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => ({ ...DEFAULT_MAINTENANCE_PREFS, intervalMinutes: 1 }),
      getRepoPaths: () => [],
      runSweep: async (p) => report(p),
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return {}
      },
    })
    scheduler.start()
    expect(timers).toEqual([MIN_INTERVAL_MINUTES * 60 * 1000])
  })

  it('unrefs its timer so it never holds the process open', () => {
    const unref = vi.fn()
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => [],
      runSweep: async (p) => report(p),
      setTimer: () => ({ unref }),
    })
    scheduler.start()
    expect(unref).toHaveBeenCalled()
  })

  it('start is idempotent', () => {
    const setTimer = vi.fn(() => ({}))
    const scheduler = new MaintenanceScheduler({
      getPrefs: () => DEFAULT_MAINTENANCE_PREFS,
      getRepoPaths: () => [],
      runSweep: async (p) => report(p),
      setTimer,
    })
    scheduler.start()
    scheduler.start()
    expect(setTimer).toHaveBeenCalledTimes(1)
  })
})
