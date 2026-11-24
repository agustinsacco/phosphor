import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_MAINTENANCE_PREFS, type MaintenanceReport } from '@shared/models'
import { enterDaemonMode } from './__fixtures__/daemon-mode'
import type { SweepOptions } from './sweep'

/**
 * The sweep with This Mac's lanes in the service: it covers the folders the
 * service keeps, protects the lanes it runs, and never sweeps blind while
 * the service is not connected.
 */

const state = vi.hoisted(() => ({
  live: [] as Array<{ workspacePath: string }>,
  recent: [] as Array<{ path: string }>,
  sweep: vi.fn<(options: SweepOptions) => Promise<MaintenanceReport>>(),
}))
vi.mock('../store', () => ({
  getPrefs: () => ({ maintenance: DEFAULT_MAINTENANCE_PREFS, recentWorkspaces: state.recent }),
}))
// Desktop runs no lanes in daemon mode, and its recents are not the service's folders.
vi.mock('../registry', () => ({ registry: { list: () => [{ workspacePath: '/in-app' }] } }))
vi.mock('../routines', () => ({ routineProtectedPaths: () => ['/routine'] }))
vi.mock('../fs/git-worktrees', () => ({ normalizeRealPath: (path: string) => path }))
vi.mock('./sweep', () => ({ sweep: state.sweep }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

import { SWEEP_SERVICE_DOWN, maintenanceScheduler, runAll } from './runtime'

const service = enterDaemonMode(state)

beforeEach(() => {
  service.state = 'ready'
  service.repositories = [
    { id: '0123456789abcdef', path: '/repo-a' },
    { id: 'fedcba9876543210', path: '/repo-b' },
  ]
  state.live = [{ workspacePath: '/repo-a/.phosphor/worktrees/x' }]
  state.recent = [{ path: '/recent-only' }]
  state.sweep.mockReset()
  state.sweep.mockImplementation(async ({ repoPath, liveSessionCount }) => ({
    ...({} as MaintenanceReport),
    workspacePath: repoPath,
    liveSessionCount,
  }))
})

it('sweeps the service’s folders and protects its live lanes, never Desktop’s registry', async () => {
  const reports = await runAll(true)
  expect(reports.map((r) => r.workspacePath)).toEqual(['/repo-a', '/repo-b'])
  const options = state.sweep.mock.calls[0]![0]
  expect(options.liveSessionCount).toBe(1)
  expect(options.act).toBe(true)
  expect([...options.protectedPaths].sort()).toEqual(
    ['/repo-a', '/repo-a/.phosphor/worktrees/x', '/repo-b', '/routine'].sort(),
  )
  // A lane that starts mid-sweep is protected at the final check.
  state.live = [...state.live, { workspacePath: '/repo-b/.phosphor/worktrees/y' }]
  expect(options.currentProtectedPaths?.()).toContain('/repo-b/.phosphor/worktrees/y')
})

it('refuses to sweep while the service is not connected', async () => {
  service.state = 'reconnecting'
  await expect(runAll(false)).rejects.toThrow(SWEEP_SERVICE_DOWN)
  expect(state.sweep).not.toHaveBeenCalled()
})

it('reports a lost connection mid-run per folder instead of sweeping it', async () => {
  state.sweep.mockImplementationOnce(async ({ repoPath }) => {
    service.state = 'down'
    return { workspacePath: repoPath } as MaintenanceReport
  })
  const reports = await runAll(true)
  expect(reports[1]).toMatchObject({ workspacePath: '/repo-b', errors: [SWEEP_SERVICE_DOWN] })
  expect(state.sweep).toHaveBeenCalledOnce()
})

it('a final protection check with the service gone throws, so nothing is removed', async () => {
  await runAll(true)
  const options = state.sweep.mock.calls[0]![0]
  service.state = 'down'
  expect(() => options.currentProtectedPaths?.()).toThrow(SWEEP_SERVICE_DOWN)
})

it('the scheduler sweeps the service’s folders, and none while it is not connected', async () => {
  vi.useFakeTimers()
  try {
    maintenanceScheduler.start()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(state.sweep.mock.calls.map(([o]) => o.repoPath)).toEqual(['/repo-a', '/repo-b'])
    state.sweep.mockClear()
    service.state = 'down'
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(state.sweep).not.toHaveBeenCalled()
  } finally {
    maintenanceScheduler.stop()
    vi.useRealTimers()
  }
})
