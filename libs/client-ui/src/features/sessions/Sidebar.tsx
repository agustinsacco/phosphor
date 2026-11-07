import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { MachineLabelLine } from './MachineSwitcher'
import { SidebarFooter, SidebarNavigation } from './SidebarNavigation'
import { RemoteLanes } from './RemoteLanes'
import { useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { LaneRevealEffect, localLaneGroupKey } from './laneReveal'
import { loadGroupCollapse, setGroupCollapsed, useGroupCollapse } from './groupCollapse'
import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionMeta } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useWorktreeDiscovery, type WorktreeDir } from './useWorktreeDiscovery'
import { isUnseen } from './unseen'
import { SessionList } from './SessionList'
import { useLiveSessionNames } from './useLiveSessionNames'
import { orderedSessions } from './sessionOrder'
import { useRepoPrRefresh } from './repoPrRefresh'
import { useLayoutStore } from '@/stores/layout'
import { LaneSelectionRows, type LaneSelectMode } from './LaneSelectionRows'
import {
  clearLaneSelection,
  selectLanes,
  toggleLane,
  useSelectedKeys,
  useSelectingGroup,
} from './laneSelection'
import { confirmSessionDelete, deleteLocalRow } from './localLaneDelete'
import { LocalBulkDelete, LocalDeleteDialogs } from './LocalBulkDelete'
import { SessionRow } from './LocalLaneRow'
import { PendingSessionRow } from './LocalPendingLaneRow'
import {
  LocalFolderMenuRows,
  localGroupMenuItems,
  startLocalSession,
  type LocalWorktreeModal,
} from './LocalFolderMenuRows'
import { usePullRequestsStore, localLanePullRequest } from '@/stores/pullRequests'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { useRoutineLaneIndex } from '@/stores/routines'
import { ChevronDownIcon, MoreIcon, PlusIcon, SearchIcon, Spinner } from '@/components/icons'
import {
  SectionLabel,
  WorkspaceGroupHeader,
  WorkspaceGroupTitle,
  SessionRowSkeletons,
  WorkspaceGroupSkeletons,
} from './SidebarPrimitives'
import { TreeViewModal } from './TreeViewModal'
import { LaneSearchBar } from './LaneSearchBar'
import { laneHaystack, laneMatches, laneQueryTerms, type LaneSearchFields } from './laneSearch'
import { toggleDesktopPage } from '@/navigation/desktopNavigation'
import { projectName, isWorktreeFolder } from '@/lib/path'
import {
  groupSessionsByProject,
  pendingSessionsByGroup,
  type GroupedSessions,
} from './groupSessions'
import { sessionTitle } from '@/lib/sessionTitle'
import { RemoveWorktreeModal } from '@/features/worktrees/RemoveWorktreeModal'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'

const SIDEBAR_WIDTH_KEY = 'phosphor:sidebarWidth'
const SIDEBAR_MIN = 208
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 256

function loadSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(stored) || stored === 0) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored))
}

export function Sidebar({
  workspacePath,
  onInitialReady,
}: {
  workspacePath: string
  onInitialReady?: (ready: boolean) => void
}): React.JSX.Element {
  const machineFilter = useRemoteLanesStore((s) => s.filter)
  const disk = useSessionsStore((s) => s.disk)
  const scanStatus = useSessionsStore((s) => s.scanStatus)
  const live = useSessionsStore((s) => s.live)
  const unread = useSessionsStore((s) => s.unread)
  const pinned = useSessionsStore((s) => s.pinned)
  const rewound = useSessionsStore((s) => s.rewound)
  const sessionOrder = useSessionsStore((s) => s.sessionOrder)
  const seenSessions = useSessionsStore((s) => s.seenSessions)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  /** Session file of the lane being opened right now, if any. */
  const openingPath = useSessionsStore((s) => s.opening?.path)
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)

  const recents = useWorkspacesStore((s) => s.recents)
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const [initialSidebarReady, setInitialSidebarReady] = useState(false)
  const [worktreeDiscoverySettled, setWorktreeDiscoverySettled] = useState(false)
  const [treeFor, setTreeFor] = useState<SessionMeta | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<LocalWorktreeModal | null>(null)
  /** Explicit collapse choices (prefs + this run); null until prefs load. */
  const collapsed = useGroupCollapse((s) => s.collapsed)
  /**
   * Lane search, per workspace group: which bars are open, what each is being
   * typed into, and what each is actually filtering by.
   *
   * Draft and applied are separate because Enter commits — see
   * `LaneSearchBar`. Neither is persisted: a filter that survived a restart
   * would open the app on a sidebar missing most of its lanes, with the reason
   * one scroll off screen.
   */
  const [searchOpen, setSearchOpen] = useState<Record<string, boolean>>({})
  const [searchDraft, setSearchDraft] = useState<Record<string, string>>({})
  const [searchApplied, setSearchApplied] = useState<Record<string, string>>({})
  const [width, setWidth] = useState(loadSidebarWidth)
  const [resizing, setResizing] = useState(false)
  /**
   * Worktree folders discovered under each known repo workspace, each paired
   * with the repo it belongs to.
   *
   * The root is kept, not discarded: it is what lets a worktree fold into its
   * project on the first render instead of waiting on `git:infoBatch`. See
   * `projectPathFor`.
   */
  const [worktreeDirs, setWorktreeDirs] = useState<WorktreeDir[]>([])
  const [workspaceMenuFor, setWorkspaceMenuFor] = useState<string | null>(null)
  const workspaceMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const closeWorkspaceMenu = (): void => setWorkspaceMenuFor(null)
  const [worktreeDiscoveryEpoch, setWorktreeDiscoveryEpoch] = useState(0)

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    setResizing(true)
    const onMove = (move: PointerEvent): void => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + move.clientX - startX))
      setWidth(next)
    }
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizing(false)
      const finalWidth = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth + up.clientX - startX),
      )
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Persisted workspaces only — always user folders, never worktree nodes.
   */
  const cleanRecents = useMemo(() => recents.filter((ws) => !isWorktreeFolder(ws.path)), [recents])

  /**
   * Every workspace worth listing: the known recents plus the active one and
   * any folder that currently has a live session (a session can outlive its
   * entry in recents). Worktree folders are not workspaces — instead of
   * living in recents they are discovered under each known repo (see the
   * `git:listWorktrees` effect below) and fold back into that repo's group.
   */
  const knownWorkspaces = useMemo(() => {
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

  // Scan every known workspace (capped; collapsed groups lazy-load on expand).
  // Only the pref's first read gates it: a toggle, here or on a Host folder,
  // never re-scans, and expanding a group catches it up (`toggleGroup`).
  const collapseLoaded = collapsed !== null
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
        setWorktreeDiscoveryEpoch((n) => n + 1)
      }
    })
    return unsubscribe
  }, [knownWorkspaces, workspacesHydrated, collapseLoaded])

  useEffect(() => void loadGroupCollapse(), [])

  // Wait for prefs hydration. Toggling a group changes `collapsed` but not
  // the roots, so it never re-lists.
  const prefsReady = collapsed !== null && workspacesHydrated
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
    `lanes:${unknownLanes}\u0000changes:${worktreeDiscoveryEpoch}`,
    setWorktreeDirs,
    setWorktreeDiscoverySettled,
  )

  /**
   * First paint is atomic: do not replace the sidebar skeleton until prefs,
   * worktree discovery, and every discovered session directory have settled.
   * `refreshMissing` deliberately has no boot cap here; a capped result is
   * useful for progressive refreshes, but misleading on the initial screen.
   */
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

  // Git summaries for row subtitles: refresh (debounced) whenever the disk
  // listing changes, and again on window focus (branch switches happen in
  // terminals Phosphor can't observe).
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

  const liveByDisk = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of Object.values(live)) {
      if (entry.diskPath) map.set(entry.diskPath, entry.phosphorId)
    }
    return map
  }, [live])

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

  /** Every session path currently visible in `disk`, across all workspaces. */
  const diskPaths = useMemo(() => {
    const set = new Set<string>()
    for (const metas of Object.values(disk)) {
      for (const meta of metas) set.add(meta.path)
    }
    return set
  }, [disk])

  /**
   * Live sessions with no row in `disk` yet, grouped by project.
   *
   * A freshly created session is spawned and prompted immediately, but its
   * `.jsonl` only appears once pi writes it — and the watcher adds
   * `awaitWriteFinish` plus a debounce on top of that. Without these
   * placeholders a session you just started shows no row at all until the
   * scan catches up, which reads as a dropped message.
   */
  const pendingByWorkspace = useMemo(
    () => pendingSessionsByGroup(Object.values(live), diskPaths, groups),
    [live, diskPaths, groups],
  )

  /**
   * Collapse resolution: an explicit choice wins; otherwise scanned groups
   * are open and unscanned ones start closed. That default IS the lazy-load
   * path — workspaces beyond the boot-scan cap sit collapsed until expanded,
   * which is when their first scan happens. The active workspace's project
   * is always open by default, even before its scan lands — checked via
   * `paths`, since the active folder may be a worktree merged into a group
   * whose primary `workspacePath` is the main repo.
   */
  const isGroupCollapsed = (group: GroupedSessions): boolean =>
    collapsed?.[group.workspacePath] ??
    (group.anyScanned ? false : !group.paths.includes(workspacePath))

  // The shared clock polls only visible, expanded groups plus active lanes.
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const expandedRepoPaths = useMemo(
    () => groups.filter((group) => !isGroupCollapsed(group)).map((g) => g.workspacePath),
    // isGroupCollapsed closes over `collapsed` and `workspacePath`; both are
    // listed so an expand/collapse refetches the group that just appeared.
    [groups, collapsed, workspacePath],
  )

  useRepoPrRefresh(
    sidebarVisible && (machineFilter === 'all' || machineFilter === 'local')
      ? expandedRepoPaths
      : [],
    disk,
  )

  /** Multi-select for bulk delete, one group at a time: see `laneSelection.ts`. */
  const selectingGroup = useSelectingGroup(groups.map((group) => group.workspacePath))
  const selectedPaths = useSelectedKeys(selectingGroup)

  const toggleGroup = (group: GroupedSessions, wasCollapsed: boolean): void => {
    setGroupCollapsed(group.workspacePath, !wasCollapsed)
    // Expanding catches up on anything missed while the group was unwatched,
    // across every folder merged into this project (main repo + worktrees).
    if (wasCollapsed) {
      const store = useSessionsStore.getState()
      for (const path of group.paths) void store.refreshDisk(path)
    }
  }

  const isSearching = (group: GroupedSessions): boolean => Boolean(searchOpen[group.workspacePath])

  /** Retract the filter and close the bar. The two are never separable. */
  const closeSearch = (workspacePath: string): void => {
    setSearchOpen((s) => ({ ...s, [workspacePath]: false }))
    setSearchDraft((s) => ({ ...s, [workspacePath]: '' }))
    setSearchApplied((s) => ({ ...s, [workspacePath]: '' }))
  }

  const toggleSearch = (group: GroupedSessions, isCollapsed: boolean): void => {
    if (isSearching(group)) {
      closeSearch(group.workspacePath)
      return
    }
    // A filter on a collapsed group hides its own result, so opening search
    // opens the group with it.
    if (isCollapsed) toggleGroup(group, true)
    setSearchOpen((s) => ({ ...s, [group.workspacePath]: true }))
  }

  /**
   * PRs, for matching only — the rows fetch their own.
   *
   * Safe to subscribe to whole: `byRepo` is replaced on a completed refresh,
   * which is rate-limited to once a minute per repo, not on every render of
   * the chips it feeds.
   */
  const prByRepo = usePullRequestsStore((s) => s.byRepo)
  const anySearchApplied = Object.values(searchApplied).some(Boolean)
  const liveNames = useLiveSessionNames(anySearchApplied)

  const lanePullRequest = (meta: SessionMeta) =>
    localLanePullRequest({ byRepo: prByRepo }, meta, gitByCwd[meta.cwd || workspacePath])
  /** The three identities one lane can be found by. */
  const laneFields = (meta: SessionMeta): LaneSearchFields => {
    const livePhosphorId = liveByDisk.get(meta.path)
    const liveName = livePhosphorId ? liveNames.get(livePhosphorId) : undefined
    return {
      title:
        sessionTitle(
          { explicitName: liveName ?? meta.name, firstUserText: meta.firstUserText },
          { elide: false },
        ) ?? '',
      branch: gitByCwd[meta.cwd || workspacePath]?.branch,
      pr: lanePullRequest(meta),
    }
  }

  /** A lane whose pull request merged: what "Select merged lanes" picks, as on a Host. */
  const isMerged = (meta: SessionMeta): boolean => lanePullRequest(meta)?.state === 'MERGED'
  /** The workspace menu's lane selection, over the lanes the search shows. */
  const selectGroupLanes = (group: string, visible: SessionMeta[], mode: LaneSelectMode): void => {
    if (mode === 'clear') clearLaneSelection()
    else
      selectLanes(
        group,
        (mode === 'all' ? visible : visible.filter(isMerged)).map((meta) => meta.path),
      )
  }

  // Re-run the scan for a group whose last attempt failed, across every
  // folder merged into the project, so the sidebar recovers instead of
  // pinning a permanent "Loading sessions…".
  const retryGroup = (group: GroupedSessions): void => {
    const store = useSessionsStore.getState()
    for (const path of group.paths) void store.refreshDisk(path)
  }

  // Watch exactly the visible groups: expanded ⇒ watching, collapsed ⇒ not.
  // Idempotent both ways, so re-running on scan results is fine. Gated on
  // prefs hydration to avoid a watch-then-unwatch churn at mount.
  useEffect(() => {
    if (collapsed === null) return
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
  }, [groups, collapsed])

  const rowProps = (meta: SessionMeta) => {
    const livePhosphorId = liveByDisk.get(meta.path)
    // Selection follows the CLICK, not the process. A lane whose pi is still
    // spawning is already the one the user is on, and leaving the previous row
    // highlighted for the second or two that takes is what made switching read
    // as a dropped click. Exclusive, so the list never shows two selected rows:
    // while a lane is opening, it is the selection.
    const opening = openingPath !== undefined && openingPath === meta.path
    const active =
      openingPath !== undefined
        ? opening
        : livePhosphorId === activeSessionId && activeSessionId !== null
    return {
      meta,
      workspacePath: meta.cwd || workspacePath,
      livePhosphorId,
      active,
      opening,
      unseen:
        !active &&
        ((unread[livePhosphorId ?? ''] ?? 0) > 0 ||
          isUnseen(seenSessions, meta.path, meta.lastActivityAt)),
      git: gitByCwd[meta.cwd || workspacePath],
      onOpenTree: () => setTreeFor(meta),
      onDelete: (title: string) => deleteLocalRow(meta, title, workspacePath),
    }
  }

  const sidebarLoading = !initialSidebarReady

  return (
    <aside className="bg-sidebar relative flex h-full shrink-0 flex-col" style={{ width }}>
      {/* No drag strip here any more: the window's title bar is now a single
          full-width element above every column (src/app/TopBar.tsx), which is
          also where the macOS traffic-light inset lives. */}
      <WorkspaceSwitcher />

      <SidebarNavigation onPage={toggleDesktopPage} />
      <div data-session-scroll className="flex-1 overflow-y-auto px-2 pb-2">
        <div hidden={machineFilter !== 'all' && machineFilter !== 'local'}>
          {machineFilter === 'all' && <MachineLabelLine id="local" />}
          {!sidebarLoading && pinnedMetas.length > 0 && (
            <>
              <SectionLabel>Pinned</SectionLabel>
              <SessionList
                disabled={bulkDeleteRunning}
                items={pinnedMetas.map((meta) => ({
                  id: meta.path,
                  path: meta.path,
                  content: <SessionRow {...rowProps(meta)} isPinned showWorkspace />,
                }))}
              />
            </>
          )}

          {/* Prefs decide both which workspaces exist and what order they sit
            in, so any header painted before they land can be wrong or about
            to jump. A skeleton is the honest answer for that window. */}
          {sidebarLoading && <WorkspaceGroupSkeletons />}

          {!sidebarLoading &&
            collapsed !== null &&
            groups.map((group) => {
              const isCollapsed = isGroupCollapsed(group)
              const query = searchApplied[group.workspacePath] ?? ''
              const terms = laneQueryTerms(query)
              // Filter the metas rather than hide rows: selection, shift-ranges
              // and the empty state then all read the same list the eye does.
              const local = group.metas
              const visible = terms.length
                ? local.filter((meta) => laneMatches(laneHaystack(laneFields(meta)), terms))
                : local
              const selectingThis = selectingGroup === group.workspacePath
              const visiblePaths = visible.map((m) => m.path)
              const shownTotal = local.length
              const shownCount = visible.length
              return (
                <div key={group.workspacePath}>
                  <LaneRevealEffect
                    groupKey={localLaneGroupKey(group.workspacePath)}
                    collapsed={isCollapsed}
                    expand={() => toggleGroup(group, true)}
                    clearSearch={() => closeSearch(group.workspacePath)}
                  />
                  <WorkspaceGroupHeader
                    menu={() =>
                      localGroupMenuItems(group, gitByCwd[group.workspacePath], setWorktreeModal)
                    }
                    menuTitle={group.name}
                  >
                    <WorkspaceGroupTitle
                      name={group.name}
                      collapsed={isCollapsed}
                      liveCount={group.liveCount}
                      onClick={() => toggleGroup(group, isCollapsed)}
                      data-testid="workspace-group"
                      title={group.workspacePath}
                    />
                    <TooltipButton
                      onClick={() => toggleSearch(group, isCollapsed)}
                      data-testid="workspace-group-search"
                      title="Search lanes"
                      aria-label={`Search lanes in ${group.name}`}
                      aria-expanded={isSearching(group)}
                      className={clsx(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors active:scale-90',
                        query
                          ? 'bg-accent-soft text-accent'
                          : 'text-text-tertiary hover:text-text hover:bg-sidebar-hover',
                      )}
                    >
                      <SearchIcon size={12} />
                    </TooltipButton>
                    <TooltipButton
                      ref={
                        workspaceMenuFor === group.workspacePath
                          ? workspaceMenuTriggerRef
                          : undefined
                      }
                      onClick={() =>
                        setWorkspaceMenuFor((current) =>
                          current === group.workspacePath ? null : group.workspacePath,
                        )
                      }
                      data-testid="workspace-group-menu"
                      title="Workspace options"
                      aria-label={`Workspace options for ${group.name}`}
                      // Permanent, not hover-revealed: these three controls are the
                      // workspace's fixed toolbar, and a control you cannot see is
                      // a control you do not know exists.
                      className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors"
                    >
                      <MoreIcon size={14} />
                    </TooltipButton>
                    {workspaceMenuFor === group.workspacePath && (
                      <PopupMenu
                        onClose={() => closeWorkspaceMenu()}
                        triggerRef={workspaceMenuTriggerRef}
                        className="absolute right-1 top-full z-40 mt-1 min-w-36 py-1"
                      >
                        <LaneSelectionRows
                          canSelect={selectingThis || visible.length > 0}
                          selecting={selectingThis}
                          collapsed={isCollapsed}
                          onCollapse={(next) =>
                            next !== isCollapsed && toggleGroup(group, isCollapsed)
                          }
                          onSelect={(mode) => selectGroupLanes(group.workspacePath, visible, mode)}
                          onDone={closeWorkspaceMenu}
                        />
                        <LocalFolderMenuRows
                          group={group}
                          first={groups.indexOf(group) === 0}
                          last={groups.indexOf(group) === groups.length - 1}
                          onDone={closeWorkspaceMenu}
                        />
                      </PopupMenu>
                    )}
                    <TooltipButton
                      onClick={() => startLocalSession(group.workspacePath)}
                      data-testid="workspace-group-new-session"
                      title="New session here"
                      className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors active:scale-90"
                    >
                      <PlusIcon size={12} strokeWidth={2.5} />
                    </TooltipButton>
                  </WorkspaceGroupHeader>
                  {isSearching(group) && (
                    <LaneSearchBar
                      value={searchDraft[group.workspacePath] ?? ''}
                      applied={Boolean(query)}
                      matchCount={shownCount}
                      total={shownTotal}
                      onChange={(value) =>
                        setSearchDraft((s) => ({ ...s, [group.workspacePath]: value }))
                      }
                      onCommit={() =>
                        setSearchApplied((s) => ({
                          ...s,
                          [group.workspacePath]: searchDraft[group.workspacePath] ?? '',
                        }))
                      }
                      onClear={() => closeSearch(group.workspacePath)}
                    />
                  )}
                  {/* Placeholder rows carry no name, branch or PR yet, so a
                    filter can only ever be wrong about them. While one is on,
                    they stand aside. */}
                  {!isCollapsed && (
                    <SessionList
                      disabled={Boolean(query) || selectingThis || bulkDeleteRunning}
                      items={[
                        ...(terms.length
                          ? []
                          : (pendingByWorkspace.get(group.workspacePath) ?? [])
                        ).map((phosphorId) => ({
                          id: live[phosphorId]?.diskPath ?? phosphorId,
                          path: live[phosphorId]?.diskPath,
                          content: (
                            <PendingSessionRow
                              phosphorId={phosphorId}
                              active={phosphorId === activeSessionId}
                              onDelete={(title) =>
                                confirmSessionDelete({
                                  title,
                                  sessionId: phosphorId,
                                  workspacePath: live[phosphorId]!.workspacePath,
                                })
                              }
                              git={gitByCwd[live[phosphorId]?.workspacePath ?? '']}
                            />
                          ),
                        })),
                        ...visible.map((meta) => ({
                          id: meta.path,
                          path: meta.path,
                          content: (
                            <SessionRow
                              {...rowProps(meta)}
                              isPinned={false}
                              selected={selectingThis && selectedPaths.includes(meta.path)}
                              selecting={selectingThis}
                              onToggleSelect={(shiftKey) =>
                                toggleLane(group.workspacePath, visiblePaths, meta.path, shiftKey)
                              }
                            />
                          ),
                        })),
                      ]}
                    />
                  )}
                  {!isCollapsed && shownTotal > 0 && shownCount === 0 && (
                    <div
                      data-testid="lane-search-empty"
                      className="text-text-tertiary px-2 py-2 text-sm"
                    >
                      No lanes match &ldquo;{query}&rdquo;
                    </div>
                  )}
                  {/* Rows already scanned stay put while the rest of the group
                  catches up — a partial answer must not read as the whole
                  answer, but it must not hide what we have either. */}
                  {!isCollapsed && local.length > 0 && group.unscannedPaths.length > 0 && (
                    <div className="text-text-tertiary flex items-center gap-1.5 px-2 py-1.5 text-xs">
                      <Spinner />
                      <span>
                        loading {group.unscannedPaths.length} more folder
                        {group.unscannedPaths.length === 1 ? '' : 's'}…
                      </span>
                    </div>
                  )}
                  {!isCollapsed &&
                    group.metas.length === 0 &&
                    !pendingByWorkspace.has(group.workspacePath) &&
                    (group.attempted && group.errored ? (
                      <div className="text-text-tertiary flex items-center gap-2 px-2 py-2 text-sm">
                        <span>Couldn&apos;t load sessions</span>
                        <TooltipButton
                          onClick={() => retryGroup(group)}
                          className="text-text-secondary hover:text-text rounded px-1 underline-offset-2 hover:underline"
                        >
                          Retry
                        </TooltipButton>
                      </div>
                    ) : group.attempted ? (
                      <div className="text-text-tertiary px-2 py-2 text-sm">
                        Sessions you start will show up here
                      </div>
                    ) : (
                      <SessionRowSkeletons />
                    ))}
                </div>
              )
            })}
        </div>
        <RemoteLanes />
      </div>

      <SidebarFooter />

      {treeFor && (
        <TreeViewModal
          meta={treeFor}
          workspacePath={treeFor.cwd || workspacePath}
          onClose={() => setTreeFor(null)}
        />
      )}
      {worktreeModal?.kind === 'remove' && (
        <RemoveWorktreeModal
          repoPath={worktreeModal.repoPath}
          worktree={worktreeModal.worktree}
          onClose={() => setWorktreeModal(null)}
        />
      )}
      {worktreeModal?.kind === 'merge' && (
        <MergeWorktreeModal
          repoPath={worktreeModal.repoPath}
          worktree={worktreeModal.worktree}
          onClose={() => setWorktreeModal(null)}
        />
      )}

      {groups.map((group) => (
        <LocalBulkDelete
          key={group.workspacePath}
          selectionKey={group.workspacePath}
          workspacePath={workspacePath}
        />
      ))}
      <LocalDeleteDialogs workspacePath={workspacePath} />

      {/* Width resize handle: an invisible strip over the right border. */}
      <div
        onPointerDown={startResize}
        className={clsx(
          'hover:bg-accent/40 absolute -right-0.5 top-0 z-30 h-full w-1 cursor-col-resize transition-colors',
          resizing && 'bg-accent/40',
        )}
      />
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
    </aside>
  )
}

function WorkspaceSwitcher(): React.JSX.Element {
  const currentPath = useActiveWorkspace()
  const remote = useSessionsStore((s) => {
    const entry = s.activeSessionId ? s.live[s.activeSessionId] : undefined
    return entry?.target?.kind === 'remote' ? entry : undefined
  })
  const remoteHost = useRemoteLanesStore((s) =>
    remote?.target?.kind === 'remote' ? s.hosts[remote.target.hostId] : undefined,
  )
  const [addingFolder, setAddingFolder] = useState(false)
  const remoteRepo = remoteHost?.repositories.find((repo) =>
    remoteHost.lanes.some(
      (lane) => lane.laneId === remote?.laneId && lane.repositoryId === repo.id,
    ),
  )
  const recents = useWorkspacesStore((s) => s.recents)
  const git = useSessionsStore((s) => (currentPath ? s.gitByCwd[currentPath] : undefined))
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Project only, no branch: the top bar's folder and branch chips sit a row
  // above this and already answer "where am I". Showing `Phosphor (phosphor/hey-2)`
  // here as well put the branch on screen twice and the folder twice.
  const name =
    remote?.target?.kind === 'remote'
      ? `${remoteRepo?.name ?? 'Repository'} · ${machineLabel(remote.target.hostId)}`
      : currentPath
        ? projectName(currentPath, git)
        : 'Workspace'

  return (
    // Draggable: on Windows/Linux this row sits flush against the top of the
    // window (there is no traffic-light strip above it), so it is the only
    // grab handle the sidebar has. The trigger and the menu opt back out.
    <div className="titlebar-drag relative px-3 pb-1.5 pt-1">
      <TooltipButton
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="workspace-switcher"
        tooltip="Switch workspace"
        className="hover:bg-sidebar-hover flex w-full items-center gap-2 rounded-md px-2 py-1 transition-colors"
      >
        <span className="bg-accent-soft text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base font-bold uppercase">
          {name.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-lg font-semibold">{name}</span>
        {!remote && <ChevronDownIcon className="text-text-tertiary shrink-0" />}
      </TooltipButton>

      {addingFolder && remote?.target?.kind === 'remote' && (
        <HostFolderBrowser
          key={remote.target.hostId}
          hostId={remote.target.hostId}
          onClose={() => setAddingFolder(false)}
        />
      )}
      {open && remote && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          className="absolute left-3 right-3 top-full z-40 mt-1 py-1.5"
        >
          <MenuRow
            active={false}
            disabled={
              remoteHost?.state !== 'ready' ||
              !remoteHost?.capabilities.includes('workspaces.write')
            }
            onClick={() => {
              setOpen(false)
              setAddingFolder(true)
            }}
          >
            Add folder on{' '}
            {remote.target?.kind === 'remote' ? machineLabel(remote.target.hostId) : 'machine'}…
          </MenuRow>
        </PopupMenu>
      )}
      {open && !remote && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          className="absolute left-3 right-3 top-full z-40 mt-1 py-1.5"
        >
          {recents.map((ws) => (
            <MenuRow
              key={ws.path}
              active={false}
              onClick={() => {
                setOpen(false)
                useWorkspacesStore.getState().openWorkspace(ws.path)
                useSessionsStore.getState().activate(null)
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg font-medium">{ws.name}</span>
                <span className="text-text-tertiary block truncate text-sm">{ws.path}</span>
              </span>
              {ws.path === currentPath && <span className="bg-accent h-1.5 w-1.5 rounded-full" />}
            </MenuRow>
          ))}
          <div className="border-border my-1 border-t" />
          <MenuRow
            active={false}
            onClick={() => {
              setOpen(false)
              void useWorkspacesStore
                .getState()
                .pickAndOpen()
                .then((path) => {
                  // Leave the active session, or the derived workspace keeps
                  // returning that session's folder and the newly opened one
                  // never appears.
                  if (path) useSessionsStore.getState().activate(null)
                })
            }}
          >
            <span className="text-lg">Open Folder…</span>
          </MenuRow>
        </PopupMenu>
      )}
    </div>
  )
}
