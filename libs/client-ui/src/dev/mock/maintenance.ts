import { DEFAULT_MAINTENANCE_PREFS, type MaintenancePrefs } from '@shared/models'
import type { IpcInvokeMap } from '@shared/ipc'

type Channel = 'maintenance:scan' | 'maintenance:run' | 'maintenance:setPrefs'

/** Harness storage maintenance: one reclaimable lane, prefs kept in memory. */
export const MAINTENANCE_MOCK: ReadonlySet<string> = new Set<Channel>([
  'maintenance:scan',
  'maintenance:run',
  'maintenance:setPrefs',
])

let prefs: MaintenancePrefs = DEFAULT_MAINTENANCE_PREFS

/** The `maintenance` field of the harness's `app:getPrefs`. */
export function mockMaintenancePrefs(): MaintenancePrefs {
  return prefs
}

export function mockMaintenanceInvoke(
  channel: string,
  args: unknown[],
): Promise<IpcInvokeMap[Channel]['result']> {
  if (channel === 'maintenance:setPrefs') {
    prefs = args[0] as MaintenancePrefs
    return Promise.resolve(undefined)
  }
  return Promise.resolve([
    {
      ranAt: Date.now(),
      workspacePath: '/Users/dev/projects/phosphor',
      worktreeCount: 3,
      candidates: [
        {
          path: '/repo/.phosphor/worktrees/merged-lane',
          branch: 'phosphor/merged-lane',
          bytes: 980 * 1024 * 1024,
          reason: 'merged',
        },
      ],
      held: [
        { path: '/repo', branch: 'main', reason: 'main-checkout' },
        { path: '/repo/.phosphor/worktrees/busy', branch: 'phosphor/busy', reason: 'dirty' },
      ],
      prunedRegistrations: [],
      reclaimed: [],
      reclaimableBytes: 980 * 1024 * 1024,
      reclaimedBytes: 0,
      liveSessionCount: 1,
      errors: [],
    },
  ])
}
