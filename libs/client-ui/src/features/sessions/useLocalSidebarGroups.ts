import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionMeta } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useRoutineLaneIndex } from '@/stores/routines'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useGroupCollapse } from './groupCollapse'
import {
  groupSessionsByProject,
  liveByDiskPath,
  pendingSessionsByGroup,
  type GroupedSessions,
} from './groupSessions'
import { useRepoPrRefresh } from './repoPrRefresh'
import { orderedSessions } from './sessionOrder'
import { useKnownWorkspaces } from './useKnownWorkspaces'

/**
 * This Mac's sidebar groups and what keeps them current: the known workspaces
 * and their worktrees, the scans, the first-paint gate, git summaries, the
 * grouping, pending rows, the collapse default, the watchers and PR refresh.
 */
export function useLocalSidebarGroups(
  workspacePath: string,
  onInitialReady?: (ready: boolean) => void,
) {
  const collapsed = useGroupCollapse((s) => s.collapsed)
  const known = useKnownWorkspaces(workspacePath)
  const ready = useInitialSidebarReady(known.workspaces, known.settled, onInitialReady)
  useGitRefresh(known.workspaces)
  const { groups, pinnedMetas } = useGroupedSessions(
    workspacePath,
    known.workspaces,
    known.worktreeRoots,
  )
  const pendingByWorkspace = usePendingByWorkspace(groups)

  /**
   * Collapse resolution: an explicit choice wins; otherwise scanned groups
   * are open and unscanned ones start closed. That default IS the lazy-load
   * path — workspaces beyond the boot-scan cap sit collapsed until expanded,
   * which is when their first scan happens. The active workspace's project
   * is always open by default, even before its scan lands — checked via
   * `paths`, since the active folder may be a worktree merged into a group
   * whose primary `workspacePath` is the main repo.
   */
  const isGroupCollapsed = useCallback(
    (group: GroupedSessions): boolean =>
      collapsed?.[group.workspacePath] ??
      (group.anyScanned ? false : !group.paths.includes(workspacePath)),
    [collapsed, workspacePath],
  )
  useGroupWatch(groups, collapsed !== null, isGroupCollapsed)
  return {
    /** The first paint has settled (see `useInitialSidebarReady`). */
    ready,
    /** The collapse pref has been read. */
    collapseLoaded: collapsed !== null,
    groups,
    pinnedMetas,
    pendingByWorkspace,
    isGroupCollapsed,
  }
}

/**
 * First paint is atomic: do not replace the sidebar skeleton until prefs,
 * worktree discovery, and every discovered session directory have settled.
 * `refreshMissing` deliberately has no boot cap here; a capped result is
 * useful for progressive refreshes, but misleading on the initial screen.
 */
function useInitialSidebarReady(
  knownWorkspaces: string[],
  worktreeDiscoverySettled: boolean,
  onInitialReady: ((ready: boolean) => void) | undefined,
): boolean {
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const collapsed = useGroupCollapse((s) => s.collapsed)
  const [initialSidebarReady, setInitialSidebarReady] = useState(false)
  useEffect(() => {
    if (
      initialSidebarReady ||
      !workspacesHydrated ||
      collapsed === null ||
      !worktreeDiscoverySettled
    ) {
      return
    }
    let cancelled = false
    void useSessionsStore
      .getState()
      .refreshMissing(knownWorkspaces)
      .finally(() => {
        if (!cancelled) setInitialSidebarReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [
    initialSidebarReady,
    workspacesHydrated,
    collapsed,
    worktreeDiscoverySettled,
    knownWorkspaces,
  ])

  useEffect(() => {
    if (initialSidebarReady) onInitialReady?.(true)
  }, [initialSidebarReady, onInitialReady])
  return initialSidebarReady
}

/**
 * Git summaries for row subtitles: refresh (debounced) whenever the disk
 * listing changes, and again on window focus (branch switches happen in
 * terminals Phosphor can't observe).
 */
function useGitRefresh(knownWorkspaces: string[]): void {
  const disk = useSessionsStore((s) => s.disk)
  useEffect(() => {
    const cwds = Object.values(disk)
      .flat()
      .map((m) => m.cwd)
      .concat(knownWorkspaces)
    const timer = setTimeout(() => {
      void useSessionsStore.getState().refreshGitInfo(cwds)
    }, 300)
    const onFocus = (): void => void useSessionsStore.getState().refreshGitInfo(cwds)
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [disk, knownWorkspaces])
}

/** The Pinned list and the project groups. */
function useGroupedSessions(
  workspacePath: string,
  knownWorkspaces: string[],
  worktreeRoots: Record<string, string>,
) {
  const disk = useSessionsStore((s) => s.disk)
  const scanStatus = useSessionsStore((s) => s.scanStatus)
  const live = useSessionsStore((s) => s.live)
  const pinned = useSessionsStore((s) => s.pinned)
  const rewound = useSessionsStore((s) => s.rewound)
  const sessionOrder = useSessionsStore((s) => s.sessionOrder)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const liveByDisk = useMemo(() => liveByDiskPath(live), [live])
  const pinnedSet = useMemo(() => new Set(pinned), [pinned])

  /**
   * Lanes a routine still owns. They are listed in the Routines page's run
   * history instead of here, so the sidebar stays the set of conversations
   * you started. Opening one from that history promotes it out of this index
   * and the row reappears, which is the only way back in.
   */
  const routineLanes = useRoutineLaneIndex()
  const isRoutineLane = useCallback(
    (meta: SessionMeta) => meta.path in routineLanes,
    [routineLanes],
  )

  /** Pinned sessions across every workspace — this group deliberately mixes. */
  const pinnedMetas = useMemo(
    () =>
      Object.values(disk)
        .flat()
        .filter((m) => pinnedSet.has(m.path) && !isRoutineLane(m))
        .sort(compareSessionsByCreation),
    [disk, pinnedSet, isRoutineLane],
  )

  /**
   * Remaining sessions grouped by *project*, live projects first.
   *
   * A linked worktree is a different folder from its main repo, so without
   * this merge step every worktree got its own header ("Phosphor", "Phosphor
   * (test)", ...) even though they're all the same project — the sidebar
   * read as more projects than actually existed. Instead, a worktree's
   * sessions fold into its main repo's group (keyed by `mainRepoPath`, from
   * `git:info`); the worktree/branch a session actually runs on is shown per
   * row via the "wt" subtitle chip, not by splitting the group.
   */
  const groups = useMemo<GroupedSessions[]>(
    () =>
      groupSessionsByProject(
        knownWorkspaces,
        disk,
        gitByCwd,
        (m) => pinnedSet.has(m.path) || isRoutineLane(m),
        (m) => liveByDisk.has(m.path),
        workspacePath,
        scanStatus,
        worktreeRoots,
        rewound,
        liveByDisk.keys(),
      ).map((group) => ({ ...group, metas: orderedSessions(group.metas, sessionOrder) })),
    [
      sessionOrder,
      rewound,
      knownWorkspaces,
      disk,
      gitByCwd,
      scanStatus,
      pinnedSet,
      isRoutineLane,
      liveByDisk,
      workspacePath,
      worktreeRoots,
    ],
  )

  return { groups, pinnedMetas }
}

/**
 * Live sessions with no row in `disk` yet, grouped by project.
 *
 * A freshly created session is spawned and prompted immediately, but its
 * `.jsonl` only appears once pi writes it — and the watcher adds
 * `awaitWriteFinish` plus a debounce on top of that. Without these
 * placeholders a session you just started shows no row at all until the
 * scan catches up, which reads as a dropped message.
 */
function usePendingByWorkspace(groups: GroupedSessions[]): Map<string, string[]> {
  const disk = useSessionsStore((s) => s.disk)
  const live = useSessionsStore((s) => s.live)
  /** Every session path currently visible in `disk`, across all workspaces. */
  const diskPaths = useMemo(() => {
    const set = new Set<string>()
    for (const metas of Object.values(disk)) {
      for (const meta of metas) set.add(meta.path)
    }
    return set
  }, [disk])
  return useMemo(
    () => pendingSessionsByGroup(Object.values(live), diskPaths, groups),
    [live, diskPaths, groups],
  )
}

/**
 * Watch exactly the visible groups (expanded ⇒ watching, collapsed ⇒ not) and
 * poll pull requests for the visible, expanded ones.
 */
function useGroupWatch(
  groups: GroupedSessions[],
  collapseLoaded: boolean,
  isGroupCollapsed: (group: GroupedSessions) => boolean,
): void {
  const machineFilter = useRemoteLanesStore((s) => s.filter)
  const disk = useSessionsStore((s) => s.disk)
  // The shared clock polls only visible, expanded groups plus active lanes.
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const expandedRepoPaths = useMemo(
    () => groups.filter((group) => !isGroupCollapsed(group)).map((g) => g.workspacePath),
    [groups, isGroupCollapsed],
  )

  useRepoPrRefresh(
    sidebarVisible && (machineFilter === 'all' || machineFilter === 'local')
      ? expandedRepoPaths
      : [],
    disk,
  )

  // Idempotent both ways, so re-running on scan results is fine. Gated on
  // prefs hydration to avoid a watch-then-unwatch churn at mount.
  useEffect(() => {
    if (!collapseLoaded) return
    const store = useSessionsStore.getState()
    const open = groups.filter((g) => !isGroupCollapsed(g))
    const expanded = open.flatMap((g) => g.paths)
    const closed = groups.filter((g) => isGroupCollapsed(g)).flatMap((g) => g.paths)
    store.watchWorkspaces(expanded)
    store.unwatchWorkspaces(closed)
    /*
     * Backfill an expanded group's unscanned folders.
     *
     * Watching is not enough: chokidar runs with `ignoreInitial: true`, so a
     * lane whose .jsonl was written before the watch started fires no event
     * and never appears. The boot scan is capped by list position and lanes
     * are appended last, so those are exactly the folders that miss it. This
     * is what removes the collapse-and-re-expand dance — `refreshMissing`
     * only touches folders with no scan attempt, so it settles in one pass.
     */
    void store.refreshMissing(open.flatMap((g) => g.unscannedPaths))
  }, [groups, collapseLoaded, isGroupCollapsed])
}
