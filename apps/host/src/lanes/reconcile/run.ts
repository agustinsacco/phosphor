import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { activeFolderPaths, readOwnerFolders } from '../../config/folders-file'
import type { RunConfig } from '../../commands/run-state'
import type { RunContext } from '../../commands/run'
import { prepareStateDirectory, prepareStateFile } from '../state-dir'
import type { HostStore } from '../store'
import { reconcile } from '../reconcile'
import { readModelScans, writeModelScans } from './model-scans'
import { repairLaneModels } from './models'

function routinePaths(directory: string, uid: number | undefined) {
  const dir = join(directory, 'routines')
  if (!existsSync(join(dir, 'state.sqlite'))) return new Set<string>()
  prepareStateDirectory(dir, uid)
  const repo = new RoutineRepository(prepareStateFile(dir, uid))
  try {
    return new Set(Object.keys(repo.laneIndex()))
  } finally {
    repo.close()
  }
}

/** Local discovery runs only after acquisition (including a standby commit). */
export async function reconcileRunFolders(
  context: RunContext,
  store: HostStore,
  config: RunConfig,
  local: boolean,
  signal: AbortSignal,
) {
  const file = readOwnerFolders(dirname(config.path), context.uid)
  const paths = activeFolderPaths(file, config.config.repositories, local)
  store.syncRepositories(paths, (count) =>
    context.log?.('host', 'lanes.repositories_unavailable', { count }),
  )
  signal.throwIfAborted()
  const owner = local
    ? {
        roots: paths,
        routinePaths: routinePaths(hostStateDirectory(context.env, context.home), context.uid),
      }
    : undefined
  const sessionsRoot = piSessionsRoot(context.env, context.home)
  const counts = await (context.reconcile ?? reconcile)(
    store,
    sessionsRoot,
    (skipped) => context.log?.('host', 'lanes.skipped', { skipped }),
    signal,
    owner,
  )
  signal.throwIfAborted()
  context.log?.('host', 'lanes.reconciled', counts)
  repairModels(context, store, sessionsRoot, signal)
}

/** The start-up model repair, remembering across starts the lanes it read without a result. */
function repairModels(
  context: RunContext,
  store: HostStore,
  sessionsRoot: string,
  signal: AbortSignal,
) {
  const state = hostStateDirectory(context.env, context.home)
  const scanned = readModelScans(state, context.uid)
  const models = repairLaneModels(store, sessionsRoot, { signal, scanned })
  const { counts } = models
  if (counts.repaired + counts.skipped + counts.unreadable + counts.unchanged)
    context.log?.('host', 'lanes.models_repaired', counts)
  try {
    if (models.scanned.size || scanned.size) writeModelScans(state, context.uid, models.scanned)
  } catch {
    // Only saves work: the next start reads those lanes again.
    context.log?.('host', 'lanes.model_scans_unsaved')
  }
}
