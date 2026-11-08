import { useCallback, useEffect, useMemo, useState } from 'react'
import { isWorktreeFolder } from '@phosphor/shared/worktree-segment'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { loadGroupCollapse, useGroupCollapse } from './groupCollapse'
import { useWorktreeDiscovery, type WorktreeDir } from './useWorktreeDiscovery'

/**
 * Every workspace worth listing: the known recents plus the active one and
 * any folder that currently has a live session (a session can outlive its
 * entry in recents). Worktree folders are not workspaces — instead of living
 * in recents they are discovered under each known repo (`useWorktreeFolders`)
 * and fold back into that repo's group.
 */
export function useKnownWorkspaces(workspacePath: string) {
  const recents = useWorkspacesStore((s) => s.recents)
  const live = useSessionsStore((s) => s.live)
  /**
   * Worktree folders discovered under each known repo workspace, each paired
   * with the repo it belongs to.
   *
   * The root is kept, not discarded: it is what lets a worktree fold into its
   * project on the first render instead of waiting on `git:infoBatch`. See
   * `projectPathFor`.
   */
  const [worktreeDirs, setWorktreeDirs] = useState<WorktreeDir[]>([])
  const [settled, setSettled] = useState(false)
  const [epoch, setEpoch] = useState(0)

  /** Persisted workspaces only — always user folders, never worktree nodes. */
  const cleanRecents = useMemo(() => recents.filter((ws) => !isWorktreeFolder(ws.path)), [recents])

  const workspaces = useMemo(() => {
    // The persisted recents list is the user's sidebar order. Runtime-only
    // paths are appended, so activating or creating a session cannot promote
    // any existing workspace.
    const paths = new Set(cleanRecents.map((workspace) => workspace.path))
    if (!workspacePath.startsWith('host:')) paths.add(workspacePath)
    for (const entry of Object.values(live))
      if (entry.target?.kind !== 'remote') paths.add(entry.workspacePath)
    for (const worktree of worktreeDirs) paths.add(worktree.path)
    return [...paths].filter(Boolean)
  }, [workspacePath, live, cleanRecents, worktreeDirs])

  /** Discovered worktree folder → its repo, for first-render grouping. */
  const worktreeRoots = useMemo(
    () => Object.fromEntries(worktreeDirs.map((wt) => [wt.path, wt.root])),
    [worktreeDirs],
  )

  const relist = useCallback(() => setEpoch((n) => n + 1), [])
  useDiskScan(workspaces, relist)
  useEffect(() => void loadGroupCollapse(), [])
  useWorktreeFolders(workspacePath, cleanRecents, worktreeDirs, epoch, setWorktreeDirs, setSettled)
  return { workspaces, worktreeRoots, settled }
}

/**
 * Scan every known workspace (capped; collapsed groups lazy-load on expand),
 * then re-scan each workspace whose session folder changes. Only the pref's
 * first read gates it: a toggle, here or on a Host folder, never re-scans, and
 * expanding a group catches it up (`LocalWorkspaceGroup`).
 */
function useDiskScan(knownWorkspaces: string[], onUnknownWorktree: () => void): void {
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const collapseLoaded = useGroupCollapse((s) => s.collapsed !== null)
  useEffect(() => {
    // Never begin from the store's empty default. On first launch that would
    // scan just the resumed workspace, paint it as a complete sidebar, and
    // append the persisted projects a beat later.
    if (!workspacesHydrated || !collapseLoaded) return
    const store = useSessionsStore.getState()
    void store.refreshAllDisk(knownWorkspaces)
    void store.hydratePinned()

    const unsubscribe = window.phosphor.onSessionsChanged((payload) => {
      // Re-scan only the workspace that actually changed.
      void useSessionsStore.getState().refreshDisk(payload.workspacePath)
      // A main-owned routine can create a lane without ever entering the
      // renderer's live map. Still discover it: the row itself is hidden
      // while the routine owns it, but the folder has to be scanned for the
      // lane to reappear the moment that run is promoted.
      if (
        isWorktreeFolder(payload.workspacePath) &&
        !knownWorkspaces.includes(payload.workspacePath)
      ) {
        onUnknownWorktree()
      }
    })
    return unsubscribe
  }, [knownWorkspaces, workspacesHydrated, collapseLoaded, onUnknownWorktree])
}

/** List the worktrees under each known repo workspace, once prefs have hydrated. */
function useWorktreeFolders(
  workspacePath: string,
  cleanRecents: readonly { path: string }[],
  worktreeDirs: WorktreeDir[],
  epoch: number,
  setWorktreeDirs: (dirs: WorktreeDir[]) => void,
  setSettled: (settled: boolean) => void,
): void {
  const live = useSessionsStore((s) => s.live)
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const collapseLoaded = useGroupCollapse((s) => s.collapsed !== null)
  /** Live sessions running in a worktree folder discovery has not found yet. */
  const unknownLanes = useMemo(
    () =>
      Object.values(live).filter(
        (entry) =>
          isWorktreeFolder(entry.workspacePath) &&
          !worktreeDirs.some((wt) => wt.path === entry.workspacePath),
      ).length,
    [live, worktreeDirs],
  )
  // Wait for prefs hydration. Toggling a group changes `collapsed` but not
  // the roots, so it never re-lists.
  const prefsReady = collapseLoaded && workspacesHydrated
  const discoveryRoots = useMemo(
    () =>
      prefsReady
        ? [...cleanRecents.map((ws) => ws.path), workspacePath].filter(
            (p) => Boolean(p) && !isWorktreeFolder(p),
          )
        : null,
    [prefsReady, cleanRecents, workspacePath],
  )
  // Starting a lane does not touch `recents` (worktrees are deliberately
  // never persisted there), so a roots-only key never re-listed and a lane
  // was visible only for as long as its session stayed live. Folding the
  // count of live-but-undiscovered lanes into the key re-lists once when one
  // appears; the next pass finds it, the count returns to zero, and the key
  // settles.
  useWorktreeDiscovery(
    discoveryRoots,
    `lanes:${unknownLanes}\u0000changes:${epoch}`,
    setWorktreeDirs,
    setSettled,
  )
}
