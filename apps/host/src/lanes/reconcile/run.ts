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
  const counts = await (context.reconcile ?? reconcile)(
    store,
    piSessionsRoot(context.env, context.home),
    (skipped) => context.log?.('host', 'lanes.skipped', { skipped }),
    signal,
    owner,
  )
  signal.throwIfAborted()
  context.log?.('host', 'lanes.reconciled', counts)
}
