import { realpath } from 'node:fs/promises'
import {
  visibleWorktrees,
  visibleLane,
  sessionFileName,
  type RewoundSessions,
} from '@phosphor/shared/visible-lanes'
import {
  listWorktreeMetadata,
  normalizeRealPath,
} from '@phosphor/session-runtime/git/worktree-metadata'
import { discoverRetainedWorkspaces } from '@phosphor/session-runtime/lanes/visible-lanes'
import { canonicalRemovedPath } from '../../machine/repositories'
import type { ScanState } from '../reconcile'

export interface OwnerDiscovery {
  roots: readonly string[]
  routinePaths: ReadonlySet<string>
  rewound?: RewoundSessions
}

/** Only explicit owner roots get Desktop discovery. Ordinary Host roots keep their narrower rule. */
export async function discoverOwnerFolders(
  state: ScanState,
  sessionsRoot: string,
  owner: OwnerDiscovery,
  signal?: AbortSignal,
) {
  const roots = new Set(owner.roots.map(normalizeRealPath))
  for (const repo of state.repositories) {
    if (!roots.has(repo.path)) continue
    signal?.throwIfAborted()
    const [retained, worktrees] = await Promise.all([
      discoverRetainedWorkspaces(repo.path, sessionsRoot, [], signal),
      listWorktreeMetadata(repo.path).catch(() => []),
    ])
    for (const path of visibleWorktrees(retained, worktrees)) {
      signal?.throwIfAborted()
      // A header is evidence of a lost checkout, not authority to follow a symlink.
      if ((await canonicalRemovedPath(path).catch(() => null)) === path)
        state.folders.set(path, repo.id)
    }
    state.folders.set(repo.path, repo.id)
  }
}

export async function ownerVisibility(state: ScanState, owner: OwnerDiscovery) {
  const rewound = owner.rewound ?? {}
  const present = new Set<string>()
  // Imported rewind links live on successor rows. A vanished successor never hides its predecessor.
  for (const lane of state.known)
    if (lane.sessionFile && (await realpath(lane.sessionFile).catch(() => null)))
      present.add(sessionFileName(lane.sessionFile))
  const roots = new Set(owner.roots.map(normalizeRealPath))
  const repos = new Set(
    state.repositories.filter((repo) => roots.has(repo.path)).map((repo) => repo.id),
  )
  return (file: string, repo: string) =>
    !repos.has(repo) ||
    visibleLane(file, rewound, present, { hidden: owner.routinePaths.has(file) })
}
