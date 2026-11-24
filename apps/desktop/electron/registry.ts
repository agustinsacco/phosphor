import { app } from 'electron'
import { isDesktopBrainLane } from './brain/lane-folder'
import { assertInAppRuntime, localRuntimeMode } from './local-machine/mode'
import { SessionRegistry } from './pi/session-registry'

/**
 * Every in-app lane process starts here (`desktopSessions`, `spawnSession`,
 * routines), so the mode guard sits here: in daemon mode no pi is spawned,
 * except in Desktop's private Brain lane (docs/brain.md).
 */
class InAppSessionRegistry extends SessionRegistry {
  override create(...args: Parameters<SessionRegistry['create']>) {
    const [workspacePath] = args
    if (
      localRuntimeMode() !== 'daemon' ||
      !isDesktopBrainLane(workspacePath, app.getPath('userData'))
    )
      assertInAppRuntime('start an in-app lane')
    return super.create(...args)
  }
}

export const registry: SessionRegistry = new InAppSessionRegistry()
