import { listCatalogueModels } from './agent-settings'
import {
  listModelsViaRpc,
  resolveCatalogueModels,
  type CatalogueModel,
  type CatalogueResult,
} from './model-catalogue'
import { cachedPiHealth } from './health'
import { resolvePiInvoker } from './invoker'
import { invalidateCommandCaches, probeCommandsCached, type CommandProbeOptions } from './commands'
import { createTtlCache } from './ttl-cache'
import { piStubPath } from './stub'
import { broadcast } from '../broadcast'
import type { RpcSlashCommand } from '@shared/rpc'

/** A pi answer stays believed for five minutes; degraded config answers for twenty seconds. */
const CATALOGUE_TTL_MS = 5 * 60_000
const CATALOGUE_FALLBACK_TTL_MS = 20_000

/** Across pickers, dedupe loads but never remember an empty, retryable catalogue. */
const catalogueCache = createTtlCache(
  async (): Promise<CatalogueResult> => {
    const stub = piStubPath()
    // Discovery errors reject the load, while launch errors use the config fallback.
    // Keep this preflight outside resolveCatalogueModels to preserve that distinction.
    const health = stub ? null : await cachedPiHealth()
    const result = await resolveCatalogueModels(
      async () => {
        if (stub) return process.execPath
        return health?.ok ? (health.binaryPath ?? null) : null
      },
      listCatalogueModels,
      async () => {
        const invoker = await resolvePiInvoker('minimal-stub')
        return invoker.stub
          ? listModelsViaRpc(invoker.binaryPath, invoker.prefixArgs)
          : listModelsViaRpc(invoker.binaryPath, invoker.prefixArgs, invoker.env)
      },
    )
    if (result.models.length === 0) throw new Error('no models available')
    return result
  },
  (result) => (result.source === 'pi' ? CATALOGUE_TTL_MS : CATALOGUE_FALLBACK_TTL_MS),
)

/** The cached catalogue's models, loading it if needed (session naming). */
export async function catalogueModels(): Promise<CatalogueModel[]> {
  return (await catalogueCache.get()).models
}

/** An empty load is retryable, but the picker still receives a result, not an error. */
export async function catalogueResult(): Promise<CatalogueResult> {
  try {
    return await catalogueCache.get()
  } catch {
    return { models: [], source: 'config' }
  }
}

/** Drop the cached catalogue — call after anything that changes pi's config. */
export function invalidateCatalogueModels(): void {
  catalogueCache.invalidate()
}

/** Resolve the launch while retaining the command menu's missing-pi error text. */
async function commandProbeOptions(
  workspacePath: string | undefined,
): Promise<CommandProbeOptions> {
  if (!piStubPath()) {
    // One discovery per call: an unhealthy result is not cached, so asking the
    // resolver first and health again for the message would probe twice and
    // could report a different answer. A healthy result is cached for the resolver.
    const health = await cachedPiHealth()
    if (!health.ok || !health.binaryPath) throw new Error(health.message ?? 'pi is not installed')
  }
  const invoker = await resolvePiInvoker('minimal-stub')
  return {
    ...(workspacePath ? { workspacePath } : {}),
    binaryPath: invoker.binaryPath,
    ...(invoker.prefixArgs.length ? { prefixArgs: invoker.prefixArgs } : {}),
    env: invoker.env,
  }
}

/** A failed probe is an empty list with a reason, not a loading or missing menu. */
export async function piCommands(
  workspacePath?: string,
): Promise<{ commands: RpcSlashCommand[]; error?: string }> {
  try {
    return { commands: await probeCommandsCached(await commandProbeOptions(workspacePath)) }
  } catch (cause) {
    return { commands: [], error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Forget every folder's commands and tell every window to re-ask.
 * Call after mutations: renderers re-ask immediately, including live sessions.
 * Packages refresh the home composer; skills and MCP prompts also refresh live pi.
 */
export function invalidatePiCommands(): void {
  invalidateCommandCaches()
  broadcast('pi:commandsChanged', {})
}
