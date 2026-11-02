import { app } from 'electron'
import { join } from 'node:path'
import { prepareSessionLaunch } from '@phosphor/session-runtime/pi/session-launch'
import { resolvePiInvoker } from './invoker'
import { claudeProviderSpawnEnv } from './provider-detect'
import { artifactStoreEnv } from '../artifacts/artifact-store-root'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { piAgentDir } from './pi-paths'
import { log } from '../debug-log'
import { prefs } from '../prefs/backend'
import type { RawPrefs } from '../prefs-migrations'
import { migrateRetiredDirectives } from './retired-directives'

const resourceRoot = () =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../libs/pi-extensions')

/** Installed before any pi probe/session; user edits and deletion survive updates. */
export function ensureDesktopArtifactSkill(restore = false): void {
  seedArtifactSkill(resourceRoot(), piAgentDir(), restore)
}

/** Once per launch, before any session: what Phosphor adds to or moves into pi's config. */
export function preparePiConfig(): void {
  try {
    ensureDesktopArtifactSkill()
  } catch (error) {
    // A read-only pi configuration must not prevent Desktop from opening.
    log('skills', 'Could not install bundled visual-artifacts skill', { error: String(error) })
  }
  migrateRetiredDirectives(prefs() as unknown as RawPrefs, piAgentDir(), (message, data) =>
    log('directives', message, data),
  )
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
