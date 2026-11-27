import { app } from 'electron'
import { isDesktopBrainLane } from './brain/lane-folder'
import { launchedBrainOwner } from './brain/owner-gate'
import { assertInAppRuntime, localRuntimeMode } from './local-machine/mode'
import { SessionRegistry } from './pi/session-registry'

/**
 * Every in-app lane process starts here (`desktopSessions`, `spawnSession`,
 * routines), so the mode guard sits here: in daemon mode no pi is spawned,
 * except in Desktop's private Brain lane (docs/brain.md) while Desktop still
 * owns its Brain (docs/brain-handover.md).
 */
class InAppSessionRegistry extends SessionRegistry {
  override create(...args: Parameters<SessionRegistry['create']>) {
    const [workspacePath] = args
    const userData = app.getPath('userData')
    if (
      localRuntimeMode() !== 'daemon' ||
      !isDesktopBrainLane(workspacePath, userData) ||
      launchedBrainOwner(userData) !== 'desktop'
    )
      assertInAppRuntime('start an in-app lane')
    return super.create(...args)
  }
}

export const registry: SessionRegistry = new InAppSessionRegistry()
