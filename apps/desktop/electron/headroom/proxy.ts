import { spawn } from 'node:child_process'
import { app } from 'electron'
import { getPrefs, setHeadroomPrefs } from '../store'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '@phosphor/session-runtime/pi/shell-env'
import { log } from '../debug-log'
import { headroomVersion } from '@phosphor/session-runtime/headroom/proxy-detection'
import { HEADROOM_PROXY_PORT } from '@phosphor/session-runtime/headroom/proxy-process'
import {
  createHeadroomSupervisor,
  type HeadroomSupervisor,
} from '@phosphor/session-runtime/headroom/supervisor'

/** The app-wide supervisor. Constructed lazily; nothing runs until used. */
let supervisor: HeadroomSupervisor | null = null

export function headroomSupervisor(): HeadroomSupervisor {
  supervisor ??= createHeadroomSupervisor({
    port: HEADROOM_PROXY_PORT,
    fetchImpl: fetch,
    spawnImpl: spawn,
    resolveBinaryImpl: resolveBinary,
    envImpl: piProcessEnv,
    versionImpl: headroomVersion,
    onWillQuit: (handler) => app.on('will-quit', handler),
    isEnabled: () => getPrefs().headroom.enabled,
    setEnabled: (enabled) => setHeadroomPrefs({ enabled }),
    logImpl: (message) => log('headroom', message),
  })
  return supervisor
}
