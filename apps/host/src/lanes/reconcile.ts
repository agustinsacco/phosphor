import { realpathSync } from 'node:fs'
import { discoverOwnerFolders, ownerVisibility, type OwnerDiscovery } from './reconcile/owner'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'
import type { HostStore, StoredLane } from './store'
import { discoverFolders } from './reconcile/folders'
import { admitSessions, removeMissingSessions } from './reconcile/sessions'
import { isInside } from '@phosphor/session-runtime/fs-safety'

export { RECONCILE_LIMITS } from './reconcile/folders'

export interface ScanState {
  repositories: RepositorySummary[]
  known: StoredLane[]
  folders: Map<string, string>
  added: number
  removed: number
  skipped: number
  liveLanes: number
  visible?: (file: string, repo: string) => boolean
  admissionsFull: boolean
}

/** Folders a reserved lane owns (`session/reserved-lanes.ts`): never a lane, whatever lists them. */
function dropReserved(state: ScanState, reserved: readonly string[]): string[] {
  const roots = reserved.map((root) => {
    try {
      return realpathSync.native(root)
    } catch {
      return root
    }
  })
  for (const folder of state.folders.keys())
    if (roots.some((root) => isInside(root, folder))) state.folders.delete(folder)
  return roots
}

/**
 * Rows an older Host stored for a reserved folder leave every inventory. Their transcripts stay:
 * the reserved lane continues them under its own binding, never as a store lane.
 */
function retireReserved(store: HostStore, state: ScanState, roots: readonly string[]): void {
  state.known = state.known.filter((lane) => {
    let cwd = lane.cwd
    try {
      cwd = realpathSync.native(cwd)
    } catch {
      // A removed folder is compared as written.
    }
    if (!roots.some((root) => isInside(root, cwd))) return true
    store.markRemoved(lane.laneId)
    state.removed++
    return false
  })
}

/** Scan only names and the bounded first line. No transcript messages are loaded. */
export async function reconcile(
  store: HostStore,
  sessionsRoot: string,
  log: (skipped: number) => void = () => {},
  signal?: AbortSignal,
  owner?: OwnerDiscovery,
  reserved: readonly string[] = [],
): Promise<{ repositories: number; lanes: number; added: number; removed: number }> {
  signal?.throwIfAborted()
  const state: ScanState = {
    repositories: store.listRepositories(),
    known: store.listLanes(),
    folders: new Map(),
    added: 0,
    removed: 0,
    skipped: 0,
    liveLanes: 0,
    admissionsFull: false,
  }
  await discoverFolders(state, signal, owner?.roots)
  if (owner) {
    await discoverOwnerFolders(state, sessionsRoot, owner, signal)
    dropReserved(state, reserved)
    state.visible = await ownerVisibility(state, {
      ...owner,
      rewound: owner.rewound ?? store.folders.rewoundFiles(),
    })
  }
  retireReserved(store, state, dropReserved(state, reserved))
  await removeMissingSessions(store, state, signal)
  state.liveLanes = store.listLanes().length
  await admitSessions(store, state, sessionsRoot, signal)
  signal?.throwIfAborted()
  store.pruneRemovedLanes()
  if (state.skipped) log(state.skipped)
  return {
    repositories: state.repositories.length,
    lanes: store.listLanes().length,
    added: state.added,
    removed: state.removed,
  }
}
