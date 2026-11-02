import { handle } from './handle'
import {
  checkAgentSettings,
  listPiResources,
  patchAgentSettings,
  patchWebSearchConfig,
  readAgentSettingsScoped,
  readWebSearchConfig,
  readConfigFile,
  writeConfigFile,
} from '../pi/agent-settings'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import {
  readGlobalInstructions,
  writeGlobalInstructions,
} from '@phosphor/session-runtime/pi/global-instructions'
import { piAgentDir } from '../pi/pi-paths'
import {
  catalogueResult,
  piCommands,
  invalidateCatalogueModels,
  invalidatePiCommands,
} from '../pi/catalogue'
import { type ConfigFileHealth } from '@shared/models'

// Compatibility for callers migrating away from the IPC registrar.
export { catalogueModels, invalidateCatalogueModels, invalidatePiCommands } from '../pi/catalogue'

/** Reading and patching pi's own agent settings files. */
export function registerPiConfigHandlers(): void {
  handle('pi:agentSettings', (_event, workspacePath?: string) => readAgentSettings(workspacePath))

  handle('pi:agentSettingsScoped', (_event, workspacePath?: string) =>
    readAgentSettingsScoped(workspacePath),
  )

  handle('pi:catalogueModels', () => catalogueResult())

  handle('pi:commands', (_event, workspacePath?: string) => piCommands(workspacePath))

  handle('pi:readConfigFile', (_event, name) => readConfigFile(name))

  handle('pi:writeConfigFile', (_event, name, content) => writeConfigFile(name, content))

  // This Mac's own file: links are followed (dotfiles), and a save goes through them.
  handle('pi:readInstructions', () => readGlobalInstructions(piAgentDir(), { followLinks: true }))

  handle('pi:writeInstructions', (_event, content: string, revision: string) =>
    writeGlobalInstructions(piAgentDir(), content, revision, { followLinks: true }),
  )

  handle('pi:patchAgentSettings', async (_event, scope, workspacePath, patch) => {
    // Declaring a provider or a model in settings.json changes what pi will
    // report, so the cached catalogue is stale the moment this lands — and so
    // is the command list, since settings.json also declares packages, skills
    // and extensions.
    invalidateCatalogueModels()
    const result = await patchAgentSettings(scope, workspacePath, patch)
    invalidatePiCommands()
    return result
  })

  handle('pi:checkAgentSettings', async (_event, workspacePath?: string) => {
    const result = await checkAgentSettings(workspacePath)
    // Don't ship parsed contents over IPC — only the health of each file.
    const strip = (r: ConfigFileHealth | null): ConfigFileHealth | null =>
      r ? { exists: r.exists, malformed: r.malformed, error: r.error } : null
    return { global: strip(result.global)!, project: strip(result.project) }
  })

  handle('pi:listResources', () => listPiResources())

  handle('pi:webSearchConfig', () => readWebSearchConfig())

  handle('pi:patchWebSearchConfig', (_event, patch) => patchWebSearchConfig(patch))
}
