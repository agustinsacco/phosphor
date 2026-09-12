import { PiRpcClient } from './rpc-client'
import { piProcessEnv } from './shell-env'
import { log } from '../debug-log'
import type { Model, ModelCost, RpcResponse, RpcResponseDataMap } from '@shared/rpc'

/** One selectable model, for pickers that have no live pi process to ask. */
export interface CatalogueModel {
  id: string
  name: string
  provider: string
  reasoning: boolean
  /** Per-model thinking-level overrides (see shared/thinking.ts). */
  thinkingLevelMap?: Model['thinkingLevelMap']
  /**
   * Comparison metadata the picker shows on each row. Optional because the
   * `models.json` fallback (pi unavailable) has no authority on any of it, and
   * a fabricated context window is worse than a blank one.
   */
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCost
  /** Input modalities, e.g. `['text', 'image']`. */
  input?: string[]
}

/**
 * The home screen's model list: pi's full catalogue, with a config-only
 * fallback.
 *
 * The session composer asks a live pi process over RPC (`get_available_models`),
 * which is authoritative — full display names, every built-in provider
 * (Bedrock, Anthropic, OpenAI…), not just what the user declared in
 * models.json. Nothing is running before the first prompt, so this spawns a
 * throwaway `pi --mode rpc --no-session` process (the exact machinery every
 * live session already uses via `PiRpcClient`), asks the one question, and
 * disposes it. Same call, same data, same names — home and session render
 * identically by construction instead of by two formatters staying in sync.
 *
 * Earlier versions of this parsed `pi --list-models`'s text table instead.
 * That table only ever prints `model.id` (verified against pi's own
 * `cli/list-models.js`, which builds its rows from `m.id` and never reads
 * `m.name`, even though every model it holds in memory has one) — not a
 * parsing gap, a missing column. No text-table plumbing can fix that; only
 * asking the same question the RPC does.
 *
 * `fromConfig` remains the fallback for when pi can't be run (missing, too
 * old, or the setup screen is showing), so the picker degrades to the user's
 * declared models rather than going empty.
 *
 * `resolveBinary`, `fromConfig`, and `listModels` are injected so this
 * composes without requiring a pi binary on PATH under test.
 *
 * The fallback reports itself. It used to swallow every failure into a bare
 * `catch {}` and return the models.json list as though it were the catalogue,
 * so a transient boot-time failure showed the user a one-model picker and told
 * them their configured default was "unavailable" — with no log line, and no
 * way for a caller to know the answer was degraded. `source` is what lets both
 * the log and the picker say which list this is.
 */
export interface CatalogueResult {
  models: CatalogueModel[]
  /** `pi` when pi itself answered; `config` when models.json stood in. */
  source: 'pi' | 'config'
}

export async function resolveCatalogueModels(
  resolveBinary: () => Promise<string | null>,
  fromConfig: () => Promise<CatalogueModel[]>,
  listModels: (binaryPath: string) => Promise<CatalogueModel[]> = listModelsViaRpc,
): Promise<CatalogueResult> {
  let reason = 'pi returned no models'
  try {
    const binaryPath = await resolveBinary()
    if (binaryPath) {
      const models = await listModels(binaryPath)
      if (models.length > 0) return { models, source: 'pi' }
    } else {
      reason = 'pi is not available'
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  const models = await fromConfig()
  log('models', 'catalogue fell back to models.json', { reason, models: models.length })
  return { models, source: 'config' }
}

/**
 * Narrow the RPC's full Model to what pickers actually need.
 *
 * Deliberately not a passthrough: `Model` carries an index signature, so
 * forwarding it whole would ship whatever pi adds next over IPC and into the
 * renderer unreviewed. Each field here is one the picker renders.
 */
export function toCatalogueModels(models: Model[]): CatalogueModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(Array.isArray(model.input) ? { input: model.input } : {}),
  }))
}

/**
 * Ask a live pi RPC connection for its model catalogue.
 * Exported separately from `listModelsViaRpc` so tests can drive a
 * `PiRpcClient` pointed at the fake-pi fixture without a real pi binary.
 */
export async function requestAvailableModels(
  client: PiRpcClient,
  timeoutMs = 15_000,
): Promise<CatalogueModel[]> {
  const response = (await withTimeout(
    client.request({ type: 'get_available_models' }),
    timeoutMs,
    'get_available_models timed out',
  )) as RpcResponse<RpcResponseDataMap['get_available_models']>
  if (!response.success || !response.data) return []
  return toCatalogueModels(response.data.models)
}

/**
 * Spawn a session-less pi RPC process, ask `get_available_models`, dispose it.
 *
 * `cwd` genuinely does not matter — no tool runs here — but the pi AGENT DIR
 * very much does, and an earlier version of this comment claimed "nothing here
 * touches the filesystem", which was wrong. Booting pi writes `auth.json` and
 * `models-store.json`, and pi installs whatever `settings.json` declares. That
 * mattered under e2e: this was the one pi spawn that ignored `PHOSPHOR_PI_STUB`,
 * so the suite quietly shelled out to the real binary, which reached the
 * network to `npm install` a declared package into the sandboxed agent dir —
 * and npm, owning `node_modules`, pruned the hand-written fixture package a
 * test had just put there. `prefixArgs` keeps the stub on the same path as
 * every other spawn.
 */
export async function listModelsViaRpc(
  binaryPath: string,
  prefixArgs?: string[],
  env?: Record<string, string>,
): Promise<CatalogueModel[]> {
  const client = new PiRpcClient({
    cwd: process.cwd(),
    binaryPath,
    ...(prefixArgs?.length ? { prefixArgs } : {}),
    noSession: true,
    // Callers that know the environment pass it (a real pi on Windows also
    // has prefixArgs — node.exe plus the entry script — so the prefix alone no
    // longer says "stub"). Without one: stub mode runs the script through
    // Electron's own binary, which needs ELECTRON_RUN_AS_NODE to behave as
    // plain Node — the same contract `pi:createSession` uses. The login-shell
    // PATH only matters for a real pi.
    env: env ?? (prefixArgs ? { ELECTRON_RUN_AS_NODE: '1' } : await piProcessEnv()),
  })
  client.spawn()
  try {
    return await requestAvailableModels(client)
  } finally {
    await client.dispose()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
