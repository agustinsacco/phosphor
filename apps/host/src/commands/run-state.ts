import { dirname } from 'node:path'
import { activeFolderPaths, readOwnerFolders } from '../config/folders-file'
import { realpathSync } from 'node:fs'
import { reconcileRunFolders } from '../lanes/reconcile/run'
import { loadHostConfig } from '../config/load'
import { IdentityFailure } from '../control/identity'
import { createAttachments } from '../features/attachments'
import { StateFailure } from '../lanes/state-dir'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { openStore, type HostStore } from '../lanes/store'
import type { RunContext } from './run'
import type { ReceiptSink } from './run-control'
import type { RunParts } from './run-teardown'

export type RunConfig = Extract<Awaited<ReturnType<typeof loadHostConfig>>, { ok: true }>

/** The config as run reads it; one that is not usable is a config failure. */
export async function loadRunConfig(context: RunContext, signal?: AbortSignal): Promise<RunConfig> {
  const config = await (context.loadConfig ?? loadHostConfig)(context.configPath, context.uid)
  signal?.throwIfAborted()
  if (!config.ok) throw new IdentityFailure('Config is not usable. Run phosphor setup to check it.')
  return config
}

/** Refresh the local daemon's effective folders after migration restores its files. */
export function syncRunRepositories(context: RunContext, store: HostStore, config: RunConfig) {
  const file = readOwnerFolders(dirname(config.path), context.uid)
  store.syncRepositories(activeFolderPaths(file, config.config.repositories, true), (count) =>
    context.log?.('host', 'lanes.repositories_unavailable', { count }),
  )
}

/**
 * Loads the config, then opens the lane store, syncs its repositories,
 * reconciles it with pi's sessions and opens attachments, in that order.
 * The store and attachments land in `parts` as they open, so teardown closes them.
 */
export async function openRunState(
  context: RunContext,
  parts: RunParts,
  sink: ReceiptSink,
  signal: AbortSignal,
  local = false,
): Promise<{ config: RunConfig; stateDirectory: string; store: HostStore }> {
  signal.throwIfAborted()
  const config = await loadRunConfig(context, signal)
  const stateDirectory = hostStateDirectory(context.env, context.home)
  let store: HostStore
  try {
    signal.throwIfAborted()
    store = await openStore(stateDirectory, context.uid, {
      onLaneRemoved: (laneId) => parts.attachments?.remove(laneId),
      isConnected: (id) => sink.isConnected(id),
      logCorruptReceipt: (count) => context.log?.('host', 'receipts.corrupt', { count }),
      logCorruptLane: (count) => context.log?.('host', 'lanes.corrupt', { count }),
    })
    parts.store = store
    signal.throwIfAborted()
    if (!local) await reconcileRunFolders(context, store, config, false, signal)
    parts.attachments = createAttachments({
      log: (event) => context.log?.('host', event, {}),
      directory: realpathSync(stateDirectory),
      laneExists: (laneId) => parts.store?.getLane(laneId)?.removedAt === null,
      laneRetained: (laneId) => parts.store?.archives.has(laneId) ?? false,
      now: context.now,
    })
  } catch (error) {
    if (error instanceof StateFailure || error === signal.reason) throw error
    throw new StateFailure(stateDirectory, 70, 'Could not reconcile lanes.')
  }
  return { config, stateDirectory, store }
}
