import { app } from 'electron'
import { join } from 'node:path'
import type { PiHealth } from '@shared/models'
import {
  prepareSessionLaunch,
  type SessionLaunchRuntime,
} from '@phosphor/session-runtime/pi/session-launch'
import { checkPiHealth } from './health'
import { piStubPath } from './stub'
import { piProcessEnv } from './shell-env'
import { claudeProviderSpawnEnv } from './provider-detect'
import { artifactStoreEnv } from '../artifacts/artifact-store-root'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { piAgentDir } from './pi-paths'

const resourceRoot = () =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../libs/pi-extensions')

/** Installed before any pi probe/session; user edits and deletion survive updates. */
export function ensureDesktopArtifactSkill(restore = false): void {
  seedArtifactSkill(resourceRoot(), piAgentDir(), restore)
}

let cachedHealth: PiHealth | null = null
const runtime: SessionLaunchRuntime = {
  resolveExecutable: async () => {
    // The existing gate rejects this environment hook in packaged applications.
    const stub = piStubPath()
    if (stub) return { binaryPath: process.execPath, prefixArgs: [stub], stub: true }
    const health = cachedHealth?.ok ? cachedHealth : (cachedHealth = await checkPiHealth())
    if (!health.ok) throw new Error(health.message ?? 'pi is not available')
    return { binaryPath: health.binaryPath, prefixArgs: health.prefixArgs, stub: false }
  },
  // GUI launches still need the login shell's PATH to find version-managed Node.
  readEnvironment: async ({ stub }) =>
    stub
      ? { ELECTRON_RUN_AS_NODE: '1' }
      : { ...(await piProcessEnv()), ...claudeProviderSpawnEnv(), ...artifactStoreEnv() },
  resourceRoot,
}

export function prepareDesktopSessionLaunch() {
  return prepareSessionLaunch(runtime)
}
