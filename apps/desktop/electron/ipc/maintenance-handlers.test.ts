import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAINTENANCE_PREFS, type MaintenanceReport } from '@shared/models'
import type { SweepOptions } from '../maintenance/sweep'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  list: vi.fn(),
  routinePaths: vi.fn(),
  sweep: vi.fn<(options: SweepOptions) => Promise<MaintenanceReport>>(),
}))

vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../store', () => ({ getPrefs: state.getPrefs, setMaintenancePrefs: state.setPrefs }))
vi.mock('../registry', () => ({ registry: { list: state.list } }))
vi.mock('../routines', () => ({ routineProtectedPaths: state.routinePaths }))
vi.mock('../fs/git-worktrees', () => ({ normalizeRealPath: (path: string) => `/real${path}` }))
vi.mock('../maintenance/sweep', () => ({ sweep: state.sweep }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

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

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: { id: 1 } }, ...args)
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  state.handlers.clear()
  state.getPrefs.mockReturnValue({
    maintenance: { ...DEFAULT_MAINTENANCE_PREFS },
    recentWorkspaces: [{ path: '/repo' }],
  })
  state.list.mockReturnValue([{ workspacePath: '/live' }])
  state.routinePaths.mockReturnValue(['/routine'])
  state.sweep.mockImplementation(async ({ repoPath }) => report(repoPath))
  const { registerMaintenanceHandlers } = await import('./maintenance-handlers')
  expect(state.getPrefs).not.toHaveBeenCalled()
  registerMaintenanceHandlers()
})

describe('maintenance handlers characterization', () => {
  it('scans without acting even when reclamation is enabled, and explicitly runs while disabled', async () => {
    state.getPrefs.mockReturnValue({
      maintenance: { ...DEFAULT_MAINTENANCE_PREFS, reclaimMergedWorktrees: true },
      recentWorkspaces: [{ path: '/repo' }],
    })
    expect(await invoke('maintenance:scan')).toEqual([report('/repo')])
    expect(state.sweep.mock.calls[0]![0].act).toBe(false)

    const prefs = { ...DEFAULT_MAINTENANCE_PREFS, enabled: false, reclaimMergedWorktrees: false }
    state.getPrefs.mockReturnValue({ maintenance: prefs, recentWorkspaces: [{ path: '/repo' }] })
    expect(await invoke('maintenance:run')).toEqual([report('/repo')])
    expect(state.sweep.mock.calls[1]![0]).toMatchObject({ act: true, prefs })
  })

  it('protects original and real live, recent and routine paths with fresh live counts', async () => {
    state.routinePaths.mockReturnValue(['/routine', '/live'])
    await invoke('maintenance:scan')
    expect(state.sweep.mock.calls[0]![0]).toEqual({
      repoPath: '/repo',
      prefs: DEFAULT_MAINTENANCE_PREFS,
      act: false,
      liveSessionCount: 1,
      protectedPaths: ['/live', '/repo', '/routine', '/real/live', '/real/repo', '/real/routine'],
    })
    state.list.mockReturnValue([{ workspacePath: '/new' }, { workspacePath: '/other' }])
    state.routinePaths.mockReturnValue(['/scheduled'])
    await invoke('maintenance:run')
    expect(state.sweep.mock.calls[1]![0]).toMatchObject({
      liveSessionCount: 2,
      protectedPaths: [
        '/new',
        '/other',
        '/repo',
        '/scheduled',
        '/real/new',
        '/real/other',
        '/real/repo',
        '/real/scheduled',
      ],
    })
  })

  it('forwards preference values to the store and propagates validation failures', async () => {
    const prefs = { ...DEFAULT_MAINTENANCE_PREFS, minAgeHours: 123 }
    expect(await invoke('maintenance:setPrefs', prefs)).toBeUndefined()
    expect(state.setPrefs).toHaveBeenCalledWith(prefs)
    const invalid = { intervalMinutes: 'invalid' }
    state.setPrefs.mockImplementation(() => {
      throw new Error('invalid maintenance prefs')
    })
    await expect(invoke('maintenance:setPrefs', invalid)).rejects.toThrow(
      'invalid maintenance prefs',
    )
    expect(state.setPrefs).toHaveBeenLastCalledWith(invalid)
  })

  it('returns sweep error reports unchanged and propagates rejected sweeps', async () => {
    const failed = report('/repo', ['scan: unavailable'])
    state.sweep.mockResolvedValueOnce(failed)
    const reports = await invoke('maintenance:scan')
    expect(reports).toEqual([failed])
    expect((reports as MaintenanceReport[])[0]).toBe(failed)
    state.sweep.mockRejectedValueOnce(new Error('sweep rejected'))
    await expect(invoke('maintenance:run')).rejects.toThrow('sweep rejected')
  })
})
