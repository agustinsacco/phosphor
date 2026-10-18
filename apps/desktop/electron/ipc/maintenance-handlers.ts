import type { MaintenancePrefs } from '@shared/models'
import { handle } from './handle'
import { setMaintenancePrefs } from '../store'
import { runAll } from '../maintenance/runtime'

export { maintenanceScheduler } from '../maintenance/runtime'

export function registerMaintenanceHandlers(): void {
  // Every repo the scheduler covers, not just the one on screen: "Reclaim
  // now" in one workspace used to leave every other workspace's dead lanes
  // on disk, and nothing said so.
  handle('maintenance:scan', () => runAll(false))

  // Explicit user action, so it acts regardless of the pref — but only on what
  // the same policy cleared, so the button can never delete more than a sweep.
  handle('maintenance:run', () => runAll(true))

  handle('maintenance:setPrefs', (_event, value: MaintenancePrefs) => {
    setMaintenancePrefs(value)
  })
}
