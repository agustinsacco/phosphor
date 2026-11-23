import { realpathSync } from 'node:fs'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { loadHostConfig } from '../config/load'
import { IdentityFailure } from '../control/identity'
import { createAttachments } from '../features/attachments'
import { reconcile } from '../lanes/reconcile'
import { hostStateDirectory, StateFailure } from '../lanes/state-dir'
import { openStore, type HostStore } from '../lanes/store'
import type { RunContext } from './run'
import type { ReceiptSink } from './run-control'
import type { RunParts } from './run-teardown'

export type RunConfig = Extract<Awaited<ReturnType<typeof loadHostConfig>>, { ok: true }>

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
): Promise<{ config: RunConfig; stateDirectory: string; store: HostStore }> {
  signal.throwIfAborted()
  const config = await (context.loadConfig ?? loadHostConfig)(context.configPath, context.uid)
  signal.throwIfAborted()
  if (!config.ok) throw new IdentityFailure('Config is not usable. Run phosphor setup to check it.')
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
    store.syncRepositories(config.config.repositories, (count) =>
      context.log?.('host', 'lanes.repositories_unavailable', { count }),
    )
    signal.throwIfAborted()
    const counts = await (context.reconcile ?? reconcile)(
      store,
      piSessionsRoot(context.env, context.home),
      (skipped) => context.log?.('host', 'lanes.skipped', { skipped }),
      signal,
    )
    signal.throwIfAborted()
    context.log?.('host', 'lanes.reconciled', counts)
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
