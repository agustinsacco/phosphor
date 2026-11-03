import { app } from 'electron'
import { join } from 'node:path'
import { prepareSessionLaunch } from '@phosphor/session-runtime/pi/session-launch'
import { resolvePiInvoker } from './invoker'
import { claudeProviderSpawnEnv } from '@phosphor/session-runtime/pi/provider-detect'
import { artifactStoreEnv } from '../artifacts/artifact-store-root'
import { restoreArtifactSkill, seedBundledSkills } from '@phosphor/session-runtime/bundled-skills'
import { piAgentDir } from './pi-paths'
import { log } from '../debug-log'
import { prefs } from '../prefs/backend'
import type { RawPrefs } from '../prefs-migrations'
import { migrateRetiredDirectives } from './retired-directives'

const resourceRoot = () =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../libs/pi-extensions')

/** Bring back a deleted artifact skill; never overwrites edits. */
export function restoreDesktopArtifactSkill(): void {
  restoreArtifactSkill(resourceRoot(), piAgentDir())
}

/** Once per launch, before any session: what Phosphor adds to or moves into pi's config. */
export function preparePiConfig(): void {
  try {
    // Installed before any pi probe or session; user edits and deletions survive updates.
    seedBundledSkills(resourceRoot(), piAgentDir())
  } catch (error) {
    // A read-only pi configuration must not prevent Desktop from opening.
    log('skills', 'Could not install bundled skills', { error: String(error) })
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
