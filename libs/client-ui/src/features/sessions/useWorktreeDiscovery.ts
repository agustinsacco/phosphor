import { useEffect, useRef } from 'react'
import type { WorktreeInfo } from '@shared/models'

/** A worktree folder found under one of the known repo workspaces. */
export interface WorktreeDir {
  path: string
  root: string
}

/**
 * Discover the worktree folders under each known repo workspace.
 *
 * Worktrees are not persisted as workspaces (they are branches of one), so
 * the sidebar would otherwise never scan them and their sessions would vanish
 * from the project group they fold into. Listing each known working tree
 * restores them; the merge in `groupSessionsByProject` puts every one back
 * under its main repo's header.
 *
 * `roots` is null until prefs have hydrated. A listing runs once per distinct
 * `roots` + `refreshKey`: a caller re-deriving an equal `roots` array (its
 * inputs changed identity, not content) must not re-run a full
 * `git:listWorktrees` per workspace. `refreshKey` carries the reasons to list
 * again anyway — a live lane nobody has discovered yet, a session-dir change.
 *
 * State stays with the caller (`setDirs`, `setSettled`): what the listing
 * finds feeds the very `refreshKey` it is keyed on.
 */
export function useWorktreeDiscovery(
  roots: readonly string[] | null,
  refreshKey: string,
  setDirs: (dirs: WorktreeDir[]) => void,
  setSettled: (settled: boolean) => void,
): void {
  const listedKey = useRef<string | null>(null)
  useEffect(() => {
    if (roots === null) return
    const key = [...roots, refreshKey].join('\u0000')
    if (listedKey.current === key) return
    setSettled(false)
    listedKey.current = key
    let cancelled = false
    let settled = false
    void (async () => {
      const found = new Map<string, string>()
      for (const root of roots) {
        if (cancelled) return
        try {
          const worktrees = (await window.phosphor.invoke(
            'git:listWorktrees',
            root,
          )) as WorktreeInfo[]
          for (const wt of worktrees) {
            // `prunable` is git's own answer for "this folder is gone". A
            // deleted worktree is still listed until someone prunes it, and
            // without this it became a sidebar group for a directory that
            // does not exist.
            if (wt.isMain || wt.prunable) continue
            found.set(wt.realPath || wt.path, root)
          }
        } catch {
          // Not a repo, or git unavailable — nothing to discover there.
        }
      }
      if (!cancelled) {
        settled = true
        setDirs([...found].map(([path, root]) => ({ path, root })))
        setSettled(true)
      }
    })()
    return () => {
      cancelled = true
      // A listing abandoned mid-flight never settled, so its key must not
      // stand in for a finished one. Kept, it made the re-run that replaced it
      // return early whenever the roots were unchanged, and the sidebar's first
      // paint (and with it app startup) waited on `settled` forever.
      if (!settled && listedKey.current === key) listedKey.current = null
    }
  }, [roots, refreshKey, setDirs, setSettled])
}
