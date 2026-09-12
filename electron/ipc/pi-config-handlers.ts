import { handle } from './handle'
import {
  checkAgentSettings,
  listCatalogueModels,
  listPiResources,
  patchAgentSettings,
  patchWebSearchConfig,
  readAgentSettings,
  readAgentSettingsScoped,
  readWebSearchConfig,
  readConfigFile,
  writeConfigFile,
} from '../pi/agent-settings'
import {
  listModelsViaRpc,
  resolveCatalogueModels,
  type CatalogueResult,
} from '../pi/model-catalogue'
import { cachedPiHealth } from '../pi/health'
import { probeCommands } from '../pi/commands'
import { piProcessEnv } from '../pi/shell-env'
import { createTtlCache, type TtlCache } from '../pi/ttl-cache'
import { piStubPath } from '../pi/stub'
import { type ConfigFileHealth } from '@shared/models'
import type { RpcSlashCommand } from '@shared/rpc'

/** How long pi's own answer stays believed without re-spawning pi. */
const CATALOGUE_TTL_MS = 5 * 60_000

/**
 * How long a models.json fallback is reused before pi is tried again.
 *
 * Short on purpose. The fallback is not the catalogue — it is what we show
 * when pi could not be asked — so remembering it for five minutes turns one
 * slow boot into five minutes of a wrong model list. Not zero either: a user
 * with no pi at all must not respawn a process on every picker open.
 */
const CATALOGUE_FALLBACK_TTL_MS = 20_000

/**
 * The model catalogue, cached across pickers.
 *
 * Every open used to spawn `pi --mode rpc --no-session` AND run `pi --version`
 * for the health gate — two processes, hundreds of milliseconds to seconds,
 * for an answer that does not change between them. The renderer now preloads
 * this at boot (see `src/stores/modelCatalogue.ts`), so by the time a picker
 * opens the list is usually already here.
 *
 * An empty result is not cached: `resolveCatalogueModels` returns `[]` when pi
 * is missing AND models.json is empty, and that is exactly the state a user
 * fixes and retries.
 */
const catalogueCache = createTtlCache(
  async (): Promise<CatalogueResult> => {
    const stub = piStubPath()
    const health = stub ? null : await cachedPiHealth()
    const result = await resolveCatalogueModels(
      async () => {
        if (stub) return process.execPath
        return health?.ok ? (health.binaryPath ?? null) : null
      },
      listCatalogueModels,
      stub
        ? (binaryPath) => listModelsViaRpc(binaryPath, [stub])
        : async (binaryPath) =>
            listModelsViaRpc(binaryPath, health?.prefixArgs ?? [], await piProcessEnv()),
    )
    if (result.models.length === 0) throw new Error('no models available')
    return result
  },
  (result) => (result.source === 'pi' ? CATALOGUE_TTL_MS : CATALOGUE_FALLBACK_TTL_MS),
)

/** Drop the cached catalogue — call after anything that changes pi's config. */
export function invalidateCatalogueModels(): void {
  catalogueCache.invalidate()
}

/**
 * How long a folder's resolved command list is believed.
 *
 * Shorter than the catalogue's: a skill or prompt is a file the user just
 * wrote, and "I added it and Phosphor still doesn't see it" is the failure
 * that matters here. One spawn a minute per folder, only while someone is
 * typing `/` on a home screen.
 */
const COMMANDS_TTL_MS = 60_000

/**
 * Per-workspace, because the answer is: project prompts and `<ws>/.pi/skills`
 * differ by folder. Keyed by path, so two open workspaces keep two lists
 * rather than fighting over one.
 */
const commandCaches = new Map<string, TtlCache<RpcSlashCommand[]>>()

function commandsCacheFor(workspacePath: string | undefined): TtlCache<RpcSlashCommand[]> {
  const key = workspacePath ?? ''
  let cache = commandCaches.get(key)
  if (!cache) {
    cache = createTtlCache(async () => {
      const stub = piStubPath()
      if (stub) {
        return probeCommands({
          ...(workspacePath ? { workspacePath } : {}),
          binaryPath: process.execPath,
          prefixArgs: [stub],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        })
      }
      const health = await cachedPiHealth()
      if (!health.ok || !health.binaryPath) return []
      return probeCommands({
        ...(workspacePath ? { workspacePath } : {}),
        binaryPath: health.binaryPath,
        ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
        env: await piProcessEnv(),
      })
    }, COMMANDS_TTL_MS)
    commandCaches.set(key, cache)
  }
  return cache
}

/** Reading and patching pi's own agent settings files. */
export function registerPiConfigHandlers(): void {
  handle('pi:agentSettings', (_event, workspacePath?: string) => readAgentSettings(workspacePath))

  handle('pi:agentSettingsScoped', (_event, workspacePath?: string) =>
    readAgentSettingsScoped(workspacePath),
  )

  // Ask a throwaway pi RPC process for its full catalogue (built-ins +
  // models.json, with real display names and thinkingLevelMap — see
  // model-catalogue.ts), falling back to parsing models.json directly when
  // pi can't be run.
  //
  // Honors PHOSPHOR_PI_STUB like every other pi spawn. It did not, and that made
  // it the one hole in the e2e harness: opening a model picker shelled out to
  // the real binary, which boots pi against the sandboxed agent dir and
  // installs whatever `settings.json` declares — a network install, mid-suite,
  // that pruned a fixture package another test had written.
  handle('pi:catalogueModels', async () => {
    // The cache rejects on "nothing to show" so it does not remember an empty
    // list; the channel's contract is still a result.
    try {
      return await catalogueCache.get()
    } catch {
      return { models: [], source: 'config' as const }
    }
  })

  // The home composer's `/` menu. Same throwaway-pi contract as the catalogue
  // above, including the stub gate; a probe that failed answers with an empty
  // list rather than an error, since "no menu" is a fine degradation.
  handle('pi:commands', async (_event, workspacePath?: string) => {
    try {
      return { commands: await commandsCacheFor(workspacePath).get() }
    } catch {
      return { commands: [] }
    }
  })

  handle('pi:readConfigFile', (_event, name) => readConfigFile(name))

  handle('pi:writeConfigFile', (_event, name, content) => writeConfigFile(name, content))

  handle('pi:patchAgentSettings', (_event, scope, workspacePath, patch) => {
    // Declaring a provider or a model in settings.json changes what pi will
    // report, so the cached catalogue is stale the moment this lands.
    invalidateCatalogueModels()
    return patchAgentSettings(scope, workspacePath, patch)
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
