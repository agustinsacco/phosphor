import { discoverOwnerFolders, ownerVisibility, type OwnerDiscovery } from './reconcile/owner'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'
import type { HostStore, StoredLane } from './store'
import { discoverFolders } from './reconcile/folders'
import { admitSessions, removeMissingSessions } from './reconcile/sessions'

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

/** Scan only names and the bounded first line. No transcript messages are loaded. */
export async function reconcile(
  store: HostStore,
  sessionsRoot: string,
  log: (skipped: number) => void = () => {},
  signal?: AbortSignal,
  owner?: OwnerDiscovery,
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
    state.visible = await ownerVisibility(state, {
      ...owner,
      rewound: owner.rewound ?? store.folders.rewoundFiles(),
    })
  }
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
