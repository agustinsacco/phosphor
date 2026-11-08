import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { MachineLabelLine } from './MachineSwitcher'
import { SidebarFooter, SidebarNavigation } from './SidebarNavigation'
import { RemoteLanes } from './RemoteLanes'
import { useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { loadGroupCollapse, useGroupCollapse } from './groupCollapse'
import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionMeta } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useWorktreeDiscovery, type WorktreeDir } from './useWorktreeDiscovery'
import { SessionList } from './SessionList'
import { orderedSessions } from './sessionOrder'
import { useRepoPrRefresh } from './repoPrRefresh'
import { useLayoutStore } from '@/stores/layout'
import { LocalDeleteDialogs } from './LocalBulkDelete'
import { liveByDiskPath, LocalWorkspaceGroup, useLocalRows } from './LocalWorkspaceGroup'
import { SessionRow } from './LocalLaneRow'
import type { LocalWorktreeModal } from './LocalFolderMenuRows'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { useRoutineLaneIndex } from '@/stores/routines'
import { ChevronDownIcon } from '@/components/icons'
import { SectionLabel, WorkspaceGroupSkeletons } from './SidebarPrimitives'
import { TreeViewModal } from './TreeViewModal'
import { toggleDesktopPage } from '@/navigation/desktopNavigation'
import { projectName, isWorktreeFolder } from '@/lib/path'
import {
  groupSessionsByProject,
  pendingSessionsByGroup,
  type GroupedSessions,
} from './groupSessions'
import { RemoveWorktreeModal } from '@/features/worktrees/RemoveWorktreeModal'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'

const NO_PENDING: readonly string[] = Object.freeze([])

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
  const pinned = useSessionsStore((s) => s.pinned)
  const rewound = useSessionsStore((s) => s.rewound)
  const sessionOrder = useSessionsStore((s) => s.sessionOrder)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)

  const recents = useWorkspacesStore((s) => s.recents)
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const [initialSidebarReady, setInitialSidebarReady] = useState(false)
  const [worktreeDiscoverySettled, setWorktreeDiscoverySettled] = useState(false)
  const [treeFor, setTreeFor] = useState<SessionMeta | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<LocalWorktreeModal | null>(null)
  /** Explicit collapse choices (prefs + this run); null until prefs load. */
  const collapsed = useGroupCollapse((s) => s.collapsed)
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

  const { rowProps } = useLocalRows(workspacePath, setTreeFor)

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
            groups.map((group, index) => (
              <LocalWorkspaceGroup
                key={group.workspacePath}
                group={group}
                first={index === 0}
                last={index === groups.length - 1}
                collapsed={isGroupCollapsed(group)}
                workspacePath={workspacePath}
                pending={pendingByWorkspace.get(group.workspacePath) ?? NO_PENDING}
                onOpenTree={setTreeFor}
                onWorktreeModal={setWorktreeModal}
              />
            ))}
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
