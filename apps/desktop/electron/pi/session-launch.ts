import { app } from 'electron'
import { join } from 'node:path'
import { prepareSessionLaunch } from '@phosphor/session-runtime/pi/session-launch'
import { resolvePiInvoker } from './invoker'
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

export async function prepareDesktopSessionLaunch() {
  const invoker = await resolvePiInvoker('minimal-stub')
  return prepareSessionLaunch({
    resolveExecutable: async () => invoker,
    readEnvironment: async () =>
      invoker.stub
        ? invoker.env
        : { ...invoker.env, ...claudeProviderSpawnEnv(), ...artifactStoreEnv() },
    resourceRoot,
  })
}
