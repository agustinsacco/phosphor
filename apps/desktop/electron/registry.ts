import { assertInAppRuntime } from './local-machine/mode'
import { SessionRegistry } from './pi/session-registry'

/**
 * Every in-app lane process starts here (`desktopSessions`, `spawnSession`,
 * routines), so the mode guard sits here: in daemon mode no pi is spawned.
 */
class InAppSessionRegistry extends SessionRegistry {
  override create(...args: Parameters<SessionRegistry['create']>) {
    assertInAppRuntime('start an in-app lane')
    return super.create(...args)
  }
}

export const registry: SessionRegistry = new InAppSessionRegistry()
