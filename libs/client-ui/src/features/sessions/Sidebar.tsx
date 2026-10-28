import { openRemoteComposer } from '@/features/home/remoteComposer'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { MachineSwitcher, MachineLabelLine, OtherMachinesActivity } from './MachineSwitcher'
import { RemoteLanes } from './RemoteLanes'
import { useRemoteLanesStore, machineLabel, navigateToLane } from '@/stores/remoteLanes'
import { LaneRevealEffect, localLaneGroupKey } from './laneReveal'
import { TooltipButton } from '@/components/Tooltip'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { GitInfo, SessionMeta, WorktreeInfo } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { laneIsBeingDeleted, useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from '@/features/chat/subagentRuns'
import { useWorktreeDiscovery, type WorktreeDir } from './useWorktreeDiscovery'
import { useSessionBooting } from '@/features/chat/BootingIndicator'
import { promptRenameSandbox } from '@/features/workspaces/promptRenameSandbox'
import { useMenuTriggers, type ContextMenuItem } from '@/components/ContextMenu'
import { isUnseen } from './unseen'
import { SessionList, useSessionOrderActions } from './SessionList'
import { orderedSessions } from './sessionOrder'
import { sessionSubtitle } from './sessionSubtitle'
import {
  completionActions,
  openSidebarConversation,
  useRestoreWorktree,
  useSavedConversation,
} from './completionActions'
import { PrBadge, openPullRequest } from './PrBadge'
import { LaneMarker } from './LaneMarker'
import { BulkDeleteModal } from './BulkDeleteModal'
import { DeleteSessionModal, type DeleteSessionTarget } from './DeleteSessionModal'
import {
  classifyLane,
  lanesOwningWorktree,
  summarizePreflight,
  type PreflightSummary,
} from './deletePreflight'
import { laneMarker } from '@/lib/laneMarker'
import { formatCost } from '@/lib/format'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore, pullRequestFor } from '@/stores/pullRequests'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { makeRoutine, useRoutineLaneIndex } from '@/stores/routines'
import {
  ChevronDownIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
} from '@/components/icons'
import {
  LaneRow,
  WorkspaceGroupHeader,
  WorkspaceGroupTitle,
  SessionIndicator,
  SubtitleSegments,
} from './SidebarPrimitives'
import { TreeViewModal } from './TreeViewModal'
import { LaneSearchBar } from './LaneSearchBar'
import { laneHaystack, laneMatches, laneQueryTerms, type LaneSearchFields } from './laneSearch'
import { UpdatePill } from '@/features/updates/UpdatePill'
import { AccountFooter } from '@/features/account/AccountFooter'
import { useLayoutStore } from '@/stores/layout'
import { useMachinesStore } from '@/stores/machines'
import { NavigationItem as NavRow } from '@/navigation/NavigationItem'
import { PageLinks } from '@/navigation/PageLinks'
import { projectName, isWorktreeFolder } from '@/lib/path'
import {
  groupSessionsByProject,
  pendingSessionsByGroup,
  type GroupedSessions,
} from './groupSessions'
import { sessionTitle } from '@/lib/sessionTitle'
import { useNameTransition } from './nameTransition'
import { committedRename } from './inlineRename'
import { cloneSession, exportSidebarSession, renameSidebarSession } from './sidebarActions'
import { applySessionRename, copySessionDebugInfo, exportSessionHtml } from './sessionActions'
import { RemoveWorktreeModal } from '@/features/worktrees/RemoveWorktreeModal'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'

// Keep the full emoji catalog out of startup and marker-disabled sessions.
const MarkerPickerModal = lazy(() =>
  import('./MarkerPickerModal').then((module) => ({ default: module.MarkerPickerModal })),
)

const SavedConversationModal = lazy(() =>
  import('./SavedConversationModal').then((module) => ({ default: module.SavedConversationModal })),
)
const RestoreWorktreeModal = lazy(() =>
  import('./RestoreWorktreeModal').then((module) => ({ default: module.RestoreWorktreeModal })),
)

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
  const savedConversation = useSavedConversation((s) => s.meta)
  const restoringWorktree = useRestoreWorktree((s) => s.target)
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
  const activePage = useLayoutStore((s) => s.page)

  const recents = useWorkspacesStore((s) => s.recents)
  const workspacesHydrated = useWorkspacesStore((s) => s.hydrated)
  const [initialSidebarReady, setInitialSidebarReady] = useState(false)
  const [worktreeDiscoverySettled, setWorktreeDiscoverySettled] = useState(false)
  const [treeFor, setTreeFor] = useState<SessionMeta | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<{
    kind: 'remove' | 'merge'
    repoPath: string
    worktree: WorktreeInfo
  } | null>(null)
  /** Explicit collapse choices (prefs + this run); null until prefs load. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean> | null>(null)
  /**
   * Multi-select, scoped to ONE workspace group.
   *
   * Never global: a group is exactly one repo (worktrees fold into their main
   * checkout), and a destructive confirm spanning two repos is how you delete
   * the wrong branch. Selecting inside a second group replaces the selection
   * rather than extending it.
   */
  const [selection, setSelection] = useState<{ repoPath: string; paths: string[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PreflightSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteSessionTarget | null>(null)
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
  /** Anchor for shift-click ranges. */
  const rangeAnchor = useRef<string | null>(null)

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
  /** Which group's "Delete sandbox…" row is waiting for its second click. */
  const [confirmSandboxDelete, setConfirmSandboxDelete] = useState<string | null>(null)
  /** Which group's "Remove from sidebar" row is waiting for its second click. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  const sandboxPaths = useMemo(() => new Set(sandboxes.map((sandbox) => sandbox.path)), [sandboxes])
  const closeWorkspaceMenu = (): void => {
    setWorkspaceMenuFor(null)
    setConfirmSandboxDelete(null)
    setConfirmRemove(null)
  }
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
  useEffect(() => {
    // Never begin from the store's empty default. On first launch that would
    // scan just the resumed workspace, paint it as a complete sidebar, and
    // append the persisted projects a beat later.
    if (!workspacesHydrated || collapsed === null) return
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
  }, [knownWorkspaces, workspacesHydrated, collapsed])

  useEffect(() => {
    void window.phosphor
      .invoke('app:getPrefs')
      .then((prefs) => {
        setCollapsed(Object.fromEntries(prefs.collapsedWorkspaces.map((p) => [p, true])))
      })
      .catch(() => setCollapsed({}))
  }, [])

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

  /**
   * PR chips: one batched lookup per EXPANDED group, never one per lane.
   *
   * Event-driven rather than on a timer — window focus and the disk listing
   * changing are the two moments a PR's state plausibly moved. The store
   * coalesces anything inside `PR_STALE_MS`, so calling this from several
   * triggers is free. A collapsed group is not fetched at all, matching the
   * session-dir watchers: invisible means unwatched.
   */
  const expandedRepoPaths = useMemo(
    () => groups.filter((group) => !isGroupCollapsed(group)).map((g) => g.workspacePath),
    // isGroupCollapsed closes over `collapsed` and `workspacePath`; both are
    // listed so an expand/collapse refetches the group that just appeared.
    [groups, collapsed, workspacePath],
  )

  useEffect(() => {
    if (expandedRepoPaths.length === 0) return
    const refreshAll = (): void => {
      const store = usePullRequestsStore.getState()
      for (const repoPath of expandedRepoPaths) void store.refresh(repoPath)
    }
    refreshAll()
    window.addEventListener('focus', refreshAll)
    return () => window.removeEventListener('focus', refreshAll)
  }, [expandedRepoPaths])

  /**
   * Toggle one lane, or extend a range with shift.
   *
   * Selecting in a different group starts over rather than merging the two:
   * see the `selection` comment. `paths` stays in group order so the confirm
   * lists lanes the way the sidebar does.
   *
   * `visible` is the group's lanes AFTER any search filter, so a shift-range
   * spans what the reader can see rather than sweeping in filtered-out lanes
   * that a bulk delete would then take with it.
   */
  const toggleLaneSelection = (
    group: GroupedSessions,
    visible: SessionMeta[],
    path: string,
    shiftKey: boolean,
  ): void => {
    const order = visible.map((m) => m.path)
    setSelection((current) => {
      const base = current?.repoPath === group.workspacePath ? current.paths : []
      const anchorPath = rangeAnchor.current
      if (shiftKey && anchorPath && order.includes(anchorPath)) {
        const from = order.indexOf(anchorPath)
        const to = order.indexOf(path)
        if (from !== -1 && to !== -1) {
          const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
          const merged = new Set([...base, ...range])
          return { repoPath: group.workspacePath, paths: order.filter((p) => merged.has(p)) }
        }
      }
      rangeAnchor.current = path
      const next = new Set(base)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      const paths = order.filter((p) => next.has(p))
      return paths.length ? { repoPath: group.workspacePath, paths } : null
    })
  }

  const clearSelection = (): void => {
    setSelection(null)
    rangeAnchor.current = null
  }

  const selectWholeGroup = (group: GroupedSessions, visible: SessionMeta[]): void => {
    setSelection({ repoPath: group.workspacePath, paths: visible.map((m) => m.path) })
  }

  /**
   * Build the confirm's preflight at click time rather than per render.
   *
   * Reads live state through `getState()` on purpose: the streaming flag and
   * the live session name are only needed at the moment the user asks to
   * delete, and subscribing every row to them would re-render the sidebar on
   * every token.
   */
  const buildLaneDelete = (paths: string[]): PreflightSummary => {
    const chat = useChatStore.getState()
    const sessions = useSessionsStore.getState()
    const prState = usePullRequestsStore.getState()
    const markerPrefMode = useLanePrefsStore.getState().lanes.markers
    const allMetas = Object.values(disk).flat()
    const metaByPath = new Map(allMetas.map((meta) => [meta.path, meta] as const))
    // A worktree goes only with the last session using it.
    const owners = lanesOwningWorktree(
      paths.flatMap((path) => {
        const meta = metaByPath.get(path)
        return meta ? [{ path, cwd: meta.cwd || workspacePath }] : []
      }),
      [
        ...allMetas.map((m) => ({ path: m.path, cwd: m.cwd || workspacePath })),
        ...Object.values(sessions.live).map((l) => ({ path: l.diskPath, cwd: l.workspacePath })),
      ],
    )

    const lanes = paths.flatMap((path) => {
      const meta = metaByPath.get(path)
      if (!meta) return []
      const livePhosphorId = liveByDisk.get(path)
      const git = gitByCwd[meta.cwd || workspacePath]
      const liveName = livePhosphorId ? chat.sessions[livePhosphorId]?.meta?.sessionName : undefined
      const explicit = sessions.laneMarkers[path]
      return [
        classifyLane({
          meta,
          title:
            sessionTitle({
              explicitName: liveName ?? meta.name,
              firstUserText: meta.firstUserText,
            }) ?? 'Untitled session',
          marker: laneMarker(explicit, git?.branch, meta.cwd, markerPrefMode),
          git,
          pr: pullRequestFor(prState, git?.mainRepoPath ?? meta.cwd, git?.branch),
          isLive: Boolean(livePhosphorId),
          isStreaming: livePhosphorId
            ? (chat.sessions[livePhosphorId]?.isStreaming ?? false)
            : false,
          ownsWorktree: owners.has(path),
        }),
      ]
    })
    return summarizePreflight(lanes)
  }

  const openBulkDelete = (): void => {
    if (selection) setPendingDelete(buildLaneDelete(selection.paths))
  }

  /**
   * A single row's Delete. A lane that is the only session in its own
   * worktree gets the lane confirm, worktree removal on by default: deleting
   * just the transcript left the directory (and its `node_modules`) behind
   * with nothing in the sidebar pointing at it — 177 of them, 133 GB, on one
   * install. Anything else — the main checkout, a shared worktree, a row with
   * no git info yet — keeps the transcript-only confirm.
   */
  const deleteRow = (meta: SessionMeta, title: string): void => {
    const summary = buildLaneDelete([meta.path])
    if (summary.worktreeCount > 0) setPendingDelete(summary)
    else setDeleteTarget({ title, path: meta.path, workspacePath: meta.cwd || workspacePath })
  }

  /**
   * Escape exits select mode.
   *
   * Deliberately NOT a window-level listener when a modal is up: the confirm
   * is a `ModalOverlay`, whose depth-aware Escape must win, or one keypress
   * would both close the dialog and drop the selection behind it.
   */
  useEffect(() => {
    if (!selection || pendingDelete) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection, pendingDelete])

  const toggleGroup = (group: GroupedSessions, wasCollapsed: boolean): void => {
    const next = { ...(collapsed ?? {}), [group.workspacePath]: !wasCollapsed }
    setCollapsed(next)
    void window.phosphor.invoke(
      'app:setCollapsedWorkspaces',
      Object.keys(next).filter((p) => next[p]),
    )
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
  /**
   * Names of live sessions, which lead the disk scan by the watcher's
   * debounce. Without them, a lane renamed a moment ago is not findable under
   * the name the sidebar is showing.
   *
   * Subscribed as a joined STRING so streaming re-renders nothing: the chat
   * store replaces `sessions` on every token, but this value only changes when
   * a name does. The map is then rebuilt off that key, and the whole thing
   * costs nothing while no filter is applied.
   */
  const liveNameKey = useChatStore((s) =>
    anySearchApplied
      ? Object.entries(s.sessions)
          .map(([id, session]) => `${id}\u0000${session.meta?.sessionName ?? ''}`)
          .join('\u0001')
      : '',
  )
  const liveNames = useMemo(() => {
    const names = new Map<string, string>()
    if (!liveNameKey) return names
    for (const entry of liveNameKey.split('\u0001')) {
      const [id, name] = entry.split('\u0000')
      if (id && name) names.set(id, name)
    }
    return names
  }, [liveNameKey])

  /** The three identities one lane can be found by. */
  const laneFields = (meta: SessionMeta): LaneSearchFields => {
    const git = gitByCwd[meta.cwd || workspacePath]
    const repoPath = git?.mainRepoPath ?? meta.cwd ?? workspacePath
    const livePhosphorId = liveByDisk.get(meta.path)
    const liveName = livePhosphorId ? liveNames.get(livePhosphorId) : undefined
    return {
      title:
        sessionTitle(
          { explicitName: liveName ?? meta.name, firstUserText: meta.firstUserText },
          { elide: false },
        ) ?? '',
      branch: git?.branch,
      pr: pullRequestFor({ byRepo: prByRepo }, repoPath, git?.branch),
    }
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

  const groupMenuItems = (group: GroupedSessions): ContextMenuItem[] => {
    const git = gitByCwd[group.workspacePath]
    const openWorktreeModal = async (kind: 'remove' | 'merge'): Promise<void> => {
      const repoPath = git?.mainRepoPath
      if (!repoPath) return
      const worktrees = await window.phosphor.invoke('git:listWorktrees', repoPath)
      const worktree = worktrees.find(
        (w) => w.path === group.workspacePath || w.realPath === group.workspacePath,
      )
      if (worktree) setWorktreeModal({ kind, repoPath, worktree })
    }
    return [
      {
        label: 'New session',
        onClick: () => {
          useWorkspacesStore.getState().openWorkspace(group.workspacePath)
          useSessionsStore.getState().activate(null)
        },
      },
      // Only offered when the group's own representative folder is itself a
      // worktree — i.e. its main repo isn't a known workspace to fold into.
      // Once both are known and merged, this lives on the top bar's branch
      // control instead of the ambiguous, multi-folder group.
      ...(git?.isWorktree && git.mainRepoPath
        ? [
            {
              label: 'Merge into main…',
              separatorAbove: true,
              onClick: () => void openWorktreeModal('merge'),
            },
            {
              label: 'Remove worktree…',
              danger: true,
              onClick: () => void openWorktreeModal('remove'),
            },
          ]
        : []),
    ]
  }

  const moveGroup = (group: GroupedSessions, direction: 'up' | 'down'): void => {
    // A merged worktree group is represented by its main-repo workspace path,
    // which is the entry the user sees and orders in the sidebar.
    useWorkspacesStore.getState().moveWorkspace(group.workspacePath, direction)
    closeWorkspaceMenu()
  }

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
      onDelete: (title: string) => deleteRow(meta, title),
    }
  }

  const sidebarLoading = !initialSidebarReady

  return (
    <aside className="bg-sidebar relative flex h-full shrink-0 flex-col" style={{ width }}>
      {/* No drag strip here any more: the window's title bar is now a single
          full-width element above every column (src/app/TopBar.tsx), which is
          also where the macOS traffic-light inset lives. */}
      <WorkspaceSwitcher />

      {/* Flat nav rows, matching the reference: icon + label, no border or
          shadow. New routes to the home screen; the folder is chosen there
          via the composer's workspace chip. Artifacts and Skills open GLOBAL
          pages over the main region — they used to toggle a per-session right
          pane, which made both rows silent no-ops on the home screen. */}
      <nav className="px-2 pb-1.5">
        <NavRow
          label="New"
          badge
          onClick={() => {
            const filter = useRemoteLanesStore.getState().filter
            if (filter !== 'local' && filter !== 'all') openRemoteComposer(filter)
            else useSessionsStore.getState().activate(null)
          }}
          icon={<PlusIcon strokeWidth={2.5} />}
        />
        <PageLinks
          activePage={activePage}
          trailing={{ machines: <OtherMachinesActivity /> }}
          onPage={(page) => {
            if (page === 'machines' && activePage !== 'machines')
              useMachinesStore.getState().show({ kind: 'list' })
            else useLayoutStore.getState().togglePage(page)
          }}
        />
      </nav>

      <MachineSwitcher />
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
              const selectingThis = selection?.repoPath === group.workspacePath
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
                  <WorkspaceGroupHeader menu={() => groupMenuItems(group)} menuTitle={group.name}>
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
                        <MenuRow
                          active={false}
                          testId="workspace-group-select"
                          disabled={!selectingThis && visible.length < 2}
                          onClick={() => {
                            if (selectingThis) clearSelection()
                            else selectWholeGroup(group, visible)
                            closeWorkspaceMenu()
                          }}
                        >
                          {selectingThis ? 'Clear selection' : 'Select all lanes'}
                        </MenuRow>
                        <MenuRow
                          active={false}
                          disabled={groups.indexOf(group) === 0}
                          onClick={() => moveGroup(group, 'up')}
                        >
                          Move up
                        </MenuRow>
                        <MenuRow
                          active={false}
                          disabled={groups.indexOf(group) === groups.length - 1}
                          onClick={() => moveGroup(group, 'down')}
                        >
                          Move down
                        </MenuRow>
                        {/* Only a sandbox is renamed or deleted from here: it is
                          Phosphor's own scratch folder, so its name and its
                          removal are ours to offer. A project folder is the
                          user's, so it is only ever forgotten: it leaves the
                          sidebar and nothing on disk changes. This used to be
                          Settings-only, and people could not find it. */}
                        {!sandboxPaths.has(group.workspacePath) && (
                          <MenuRow
                            active={false}
                            testId="workspace-group-remove"
                            onClick={() => {
                              // Second click confirms, in place, like a sandbox
                              // delete: it is undone by opening the folder again.
                              if (confirmRemove !== group.workspacePath) {
                                setConfirmRemove(group.workspacePath)
                                return
                              }
                              closeWorkspaceMenu()
                              void useWorkspacesStore
                                .getState()
                                .removeWorkspace([
                                  group.workspacePath,
                                  ...group.paths.filter((path) => path !== group.workspacePath),
                                ])
                            }}
                          >
                            <span
                              className={confirmRemove === group.workspacePath ? 'text-danger' : ''}
                            >
                              {confirmRemove === group.workspacePath
                                ? 'Remove? Files stay on disk'
                                : 'Remove from sidebar'}
                            </span>
                          </MenuRow>
                        )}
                        {sandboxPaths.has(group.workspacePath) && (
                          <>
                            <MenuRow
                              active={false}
                              testId="workspace-group-rename-sandbox"
                              onClick={() => {
                                closeWorkspaceMenu()
                                void promptRenameSandbox(group.workspacePath)
                              }}
                            >
                              Rename sandbox…
                            </MenuRow>
                            <MenuRow
                              active={false}
                              testId="workspace-group-delete-sandbox"
                              onClick={() => {
                                // Second click confirms, in place — a sandbox goes
                                // to the Trash, so a modal would cost more than the
                                // mistake it prevents.
                                if (confirmSandboxDelete !== group.workspacePath) {
                                  setConfirmSandboxDelete(group.workspacePath)
                                  return
                                }
                                closeWorkspaceMenu()
                                void useWorkspacesStore
                                  .getState()
                                  .deleteSandbox(group.workspacePath)
                              }}
                            >
                              <span
                                className={
                                  confirmSandboxDelete === group.workspacePath ? 'text-danger' : ''
                                }
                              >
                                {confirmSandboxDelete === group.workspacePath
                                  ? 'Delete, with its chats?'
                                  : 'Delete sandbox…'}
                              </span>
                            </MenuRow>
                          </>
                        )}
                      </PopupMenu>
                    )}
                    <TooltipButton
                      onClick={() => {
                        useWorkspacesStore.getState().openWorkspace(group.workspacePath)
                        useSessionsStore.getState().activate(null)
                      }}
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
                                setDeleteTarget({
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
                              selected={
                                selection?.paths.includes(meta.path) === true && selectingThis
                              }
                              selecting={selectingThis}
                              onToggleSelect={(shiftKey) =>
                                toggleLaneSelection(group, visible, meta.path, shiftKey)
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

      <div className="border-border border-t px-3 py-2">
        <UpdatePill />
        <AccountFooter />
      </div>

      {savedConversation && (
        <Suspense fallback={null}>
          <SavedConversationModal />
        </Suspense>
      )}
      {restoringWorktree && (
        <Suspense fallback={null}>
          <RestoreWorktreeModal />
        </Suspense>
      )}
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

      {/* Bulk bar: only in select mode, so it costs no pixels the rest of the
          time. Sits over the list rather than adding a permanent toolbar row. */}
      {selection && selection.paths.length > 0 && (
        <div
          data-testid="bulk-bar"
          className="bg-surface-raised border-border-strong absolute inset-x-2 bottom-2 z-20 flex items-center gap-2 rounded-lg border px-2.5 py-2 shadow-lg"
        >
          <span className="text-sm font-semibold">{selection.paths.length} selected</span>
          <span className="flex-1" />
          <TooltipButton
            onClick={openBulkDelete}
            disabled={bulkDeleteRunning}
            className="bg-danger rounded-md px-2.5 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {bulkDeleteRunning ? 'Delete in progress' : 'Delete…'}
          </TooltipButton>
          <TooltipButton
            onClick={clearSelection}
            className="border-border text-text-secondary hover:text-text rounded-md border px-2.5 py-1 text-xs"
          >
            Cancel
          </TooltipButton>
        </div>
      )}

      {deleteTarget && (
        <DeleteSessionModal target={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
      {pendingDelete && (
        <BulkDeleteModal
          summary={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(options) => {
            const lanes = pendingDelete.deletable.map((lane) => ({
              path: lane.path,
              title: lane.title,
              worktreePath: lane.worktreePath,
              mainRepoPath: lane.mainRepoPath,
            }))
            // Progress owns its own lane snapshot, so select mode can end as
            // soon as the non-blocking notification takes over.
            setPendingDelete(null)
            clearSelection()
            void useSessionsStore.getState().deleteManySessions(workspacePath, lanes, options)
          }}
        />
      )}

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

/**
 * What a row says it is doing, in the subtitle's time slot.
 *
 * `opening` is the only one that is not about the agent: it covers the click
 * → process-up window, which is otherwise a second or more of a row that
 * looks exactly like every idle row beside it.
 */
// One line, always. A narrow sidebar used to wrap every long title onto a
// second line, so the list re-flowed as the user dragged the divider and a
// lane stopped being a fixed-height row. The full title stays in the tooltip.
const SESSION_TITLE_CLASS = 'text-text block truncate text-lg font-medium leading-5'

function SessionRow({
  meta,
  workspacePath,
  livePhosphorId,
  active,
  opening = false,
  unseen,
  git,
  isPinned,
  showWorkspace = false,
  onOpenTree,
  onDelete,
  selected = false,
  selecting = false,
  onToggleSelect,
}: {
  meta: SessionMeta
  workspacePath: string
  livePhosphorId?: string
  active: boolean
  /** This lane's process is still coming up for the click that just happened. */
  opening?: boolean
  /** Activity the user hasn't viewed yet (persisted across restarts). */
  unseen: boolean
  git?: GitInfo
  isPinned: boolean
  /**
   * Show the workspace badge. Set for groups that mix projects (Pinned),
   * where the group header cannot tell you which app a thread belongs to.
   */
  showWorkspace?: boolean
  onOpenTree: () => void
  /** This row is in the current selection. */
  selected?: boolean
  /** The group this row belongs to has an active selection. */
  selecting?: boolean
  /**
   * Absent for rows that cannot be selected — the Pinned list, which mixes
   * projects, so a selection there would span repos.
   */
  onToggleSelect?: (shiftKey: boolean) => void
  onDelete: (title: string) => void
}): React.JSX.Element {
  const orderActions = useSessionOrderActions()
  const isStreaming = useChatStore((s) =>
    livePhosphorId ? (s.sessions[livePhosphorId]?.isStreaming ?? false) : false,
  )
  const delegated = useExtensionUiStore((s) =>
    livePhosphorId
      ? hasDelegatedWork(s.widgets[livePhosphorId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
      : false,
  )
  // Prompt sent, pi not started yet: the row pulses like a streaming one, or
  // a lane that is genuinely booting reads as idle in the list.
  const booting = useSessionBooting(livePhosphorId)
  const isSuspended = useSessionsStore((s) => s.suspendedPaths.includes(meta.path))
  const deleting = useSessionsStore(
    (s) => laneIsBeingDeleted(s.bulkDelete, meta.path) || s.deletingSessionKeys.includes(meta.path),
  )
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  // A worktree lane's PRs live under the MAIN repo, which is also the key the
  // sidebar group and `gh:prsForRepo` use. Derived here rather than threaded
  // through `rowProps` so a Pinned row — which may belong to a different
  // project than the one on screen — still resolves against its own repo.
  const repoPath = git?.mainRepoPath ?? meta.cwd ?? workspacePath
  const pullRequest = usePullRequestsStore((s) => pullRequestFor(s, repoPath, git?.branch))
  const showPrStatus = useLanePrefsStore((s) => s.lanes.prStatus)
  // "No PR yet" is inferred, not reported by gh, so it needs its own gate: only
  // once a successful, untruncated fetch for this repo has completed, and
  // only for a worktree lane. Failures cannot prove absence, nor can a recent
  // PR page that might omit older lanes. A non-worktree branch (most
  // commonly the trunk itself) is not "a lane" in the PR sense, and inferring
  // "you could open a PR" there is far more often wrong than right.
  const prListingComplete = usePullRequestsStore((s) => s.byRepo[repoPath]?.complete ?? false)
  const confirmedNoPr = !pullRequest && Boolean(git?.isWorktree && git.branch) && prListingComplete
  // Only render a chip that has something to say. A non-worktree branch with
  // no confirmed PR gets none — gating on the raw preference instead would put
  // an empty chip on every plain-main session the moment the flag is on.
  const showChip = showPrStatus && Boolean(pullRequest || confirmedNoPr)
  const explicitMarker = useSessionsStore((s) => s.laneMarkers[meta.path])
  const markerMode = useLanePrefsStore((s) => s.lanes.markers)
  // Keyed on the branch, not the title: Phosphor names a session only after its
  // first turn ends, so a title-derived marker would change under the user the
  // moment the auto-namer landed.
  const marker = laneMarker(explicitMarker, git?.branch, meta.cwd, markerMode)
  const naming = useNameTransition(livePhosphorId)
  // A live session's own name beats the scanned one: `meta.name` follows a
  // rename only once the folder watcher's debounce has passed. The top bar
  // reads the live store and would rename while this row did not.
  const liveName = useChatStore((s) =>
    livePhosphorId ? s.sessions[livePhosphorId]?.meta?.sessionName : undefined,
  )
  const title =
    sessionTitle(
      { explicitName: liveName ?? meta.name, firstUserText: meta.firstUserText },
      { elide: false },
    ) ?? 'Untitled session'

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [pickingMarker, setPickingMarker] = useState(false)

  /**
   * Markers already spoken for in this workspace, so the picker can dim them.
   * Derived from EXPLICIT choices only: auto markers collide by design (the
   * palette is finite) and dimming them would grey out most of the grid.
   */
  const usedMarkers = useSessionsStore((s) => s.laneMarkers)
  const takenMarkers = useMemo(() => {
    const taken = new Set<string>()
    for (const [path, glyph] of Object.entries(usedMarkers)) {
      if (path !== meta.path && glyph) taken.add(glyph)
    }
    return taken
  }, [usedMarkers, meta.path])

  const beginRename = (): void => {
    setRenameValue(title)
    setRenaming(true)
  }

  const applyRename = (): void => {
    const name = committedRename(renameValue, title)
    setRenaming(false)
    if (!name) return
    void renameSidebarSession(workspacePath, meta, name, livePhosphorId)
  }

  const cancelRename = (): void => {
    setRenaming(false)
    setRenameValue('')
  }
  // Badge reads the session's own cwd, so a Pinned row shows the project it
  // actually belongs to rather than whatever is on screen. Project only — the
  // subtitle beneath it already carries `wt` and the branch.
  const rowWorkspaceName = projectName(meta.cwd || workspacePath, git)

  const open = (): void => openSidebarConversation(workspacePath, meta)
  const menuItems = (): ContextMenuItem[] => {
    const store = useSessionsStore.getState()
    return [
      { label: 'Open', onClick: open },
      ...orderActions,
      { label: 'Session tree…', onClick: onOpenTree },
      ...completionActions(workspacePath, meta),
      {
        label: 'Make routine…',
        onClick: () => makeRoutine(workspacePath, meta.name ?? '', meta.firstUserText ?? ''),
      },
      {
        label: isPinned ? 'Unpin' : 'Pin',
        onClick: () => store.togglePin(meta.path),
      },
      ...(markerMode === 'off'
        ? []
        : [{ label: 'Lane marker…', onClick: () => setPickingMarker(true) }]),
      // Keyboard route for the PR chip (see PrBadge).
      ...(pullRequest
        ? [
            {
              label: `Open pull request #${pullRequest.number}`,
              hint: pullRequest.state.toLowerCase(),
              onClick: () => void openPullRequest(pullRequest),
            },
          ]
        : []),
      ...(livePhosphorId
        ? [
            {
              label: 'Suspend',
              hint: '~200 MB',
              onClick: () => void store.suspendSession(livePhosphorId),
            },
          ]
        : []),
      {
        label: 'Fork',
        hint: 'new branch',
        separatorAbove: true,
        onClick: () => void store.createSession(workspacePath, { forkFrom: meta.path }),
      },
      {
        label: 'Clone',
        onClick: () => void cloneSession(workspacePath, meta, livePhosphorId),
      },
      {
        label: 'Export HTML…',
        onClick: () => void exportSidebarSession(workspacePath, meta, livePhosphorId),
      },
      {
        label: 'Copy debug info',
        onClick: () => void copySessionDebugInfo(meta, livePhosphorId),
      },
      // Spend left the row itself: it is a detail you go looking for, so it
      // waits here (and in the Home ledger) rather than trailing every lane.
      ...(meta.cost > 0
        ? [
            {
              label: 'Copy spend',
              hint: formatCost(meta.cost),
              onClick: () => void navigator.clipboard.writeText(formatCost(meta.cost)),
            },
          ]
        : []),
      {
        label: 'Delete',
        hint: bulkDeleteRunning ? 'another delete is running' : 'to trash',
        danger: true,
        separatorAbove: true,
        disabled: bulkDeleteRunning,
        onClick: () => onDelete(title),
      },
    ]
  }
  const menu = useMenuTriggers(menuItems, { title })

  const subtitle = sessionSubtitle(meta, git)
  const activity =
    isStreaming || delegated ? 'working' : opening ? 'opening' : booting ? 'starting' : undefined
  const indicatorState = activity
    ? 'streaming'
    : unseen
      ? 'unseen'
      : livePhosphorId
        ? 'live'
        : 'disk'

  const rowClassName = clsx(
    'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-[color,background-color,opacity]',
    // Selection stays a neutral fill. Working gets a separate inset rail,
    // beacon and explicit label, even when the lane is not the active one.
    active ? 'bg-sidebar-active' : !deleting && 'hover:bg-sidebar-hover',
    selected && 'bg-accent-soft',
    deleting && 'cursor-wait opacity-45',
  )

  const body = (
    <>
      {onToggleSelect && !deleting ? (
        /* The checkbox replaces the indicator in the SAME gutter, so entering
           select mode shifts nothing. Revealed on hover, or whenever the group
           already has a selection — a permanent column would cost every row
           20px forever for a rare action. */
        <span
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${title}`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            onToggleSelect(event.shiftKey)
          }}
          className={clsx(
            'grid size-5 shrink-0 place-items-center rounded-[4px] border text-2xs',
            selected
              ? 'bg-accent border-accent text-accent-text'
              : 'border-border-strong bg-surface',
            !selected && !selecting && 'hidden group-hover:grid',
          )}
          data-tooltip={`Select ${title}`}
        >
          {selected ? '✓' : ''}
        </span>
      ) : null}
      <span
        className={clsx(
          onToggleSelect && !deleting && (selecting ? 'hidden' : 'group-hover:hidden'),
        )}
      >
        <SessionIndicator state={indicatorState} />
      </span>
      {markerMode !== 'off' && (
        <LaneMarker marker={marker} onPick={deleting ? undefined : () => setPickingMarker(true)} />
      )}
      <span className="min-w-0 flex-1">
        {renaming ? (
          <RenameInput
            value={renameValue}
            onChange={setRenameValue}
            onCommit={applyRename}
            onCancel={cancelRename}
          />
        ) : (
          <span
            // Re-keyed on the title so the arrival of a generated name replays
            // the entrance; without it React patches the text node in place and
            // the name simply pops.
            key={title}
            data-tooltip={naming.pending ? 'Naming this chat…' : title}
            data-testid="session-title"
            className={clsx(
              SESSION_TITLE_CLASS,
              // Shimmers while pending, same as the top bar (.name-pending in
              // index.css) — a session you just created is watched here in
              // the sidebar at least as often as in the top bar, and a name
              // sitting still read as settled rather than still in flight.
              // The branch chip in BranchControl stays arrival-only: that combo
              // (this row, the top bar, the chip, all three at once) is what
              // previously made starting a chat read as busy.
              naming.pending && 'name-pending',
              naming.settled && 'name-enter',
            )}
          >
            {title}
          </span>
        )}
        <span
          className={clsx(
            'flex items-center gap-1 text-base leading-4',
            active ? 'text-text' : 'text-text-secondary',
          )}
        >
          {isSuspended && (
            <span
              className="bg-chip text-text-secondary mr-0.5 shrink-0 rounded px-1 font-medium"
              data-tooltip="Suspended to save memory · opening resumes it"
            >
              suspended
            </span>
          )}
          <SubtitleSegments segments={subtitle} activity={activity} />
          {showChip && <PrBadge pr={pullRequest ?? null} />}
        </span>
      </span>
      {deleting && (
        <span className="bg-chip text-text-secondary shrink-0 rounded px-1.5 py-px text-2xs font-medium">
          deleting
        </span>
      )}
      {showWorkspace && rowWorkspaceName && (
        <span
          data-testid="session-workspace-badge"
          data-tooltip={meta.cwd || workspacePath}
          className="bg-chip text-text-secondary shrink-0 rounded px-1.5 py-px text-2xs font-medium"
        >
          {rowWorkspaceName}
        </span>
      )}
      {isPinned && <PinIcon className="text-text-tertiary shrink-0" />}
    </>
  )

  // While the inline editor is up the row is a <div>, not a <button>. A text
  // field inside a button is invalid HTML (Chromium tolerates the caret, but
  // the row is announced as one button containing an unlabelled field, and
  // Enter/Space inside it are the button's to claim). Swapping the tag also
  // means there are no row handlers to suppress while editing — no
  // `renaming ? undefined : open` and no stopPropagation on the input.
  // ModalOverlay portals, so this is a sibling of the row in the DOM rather
  // than a dialog nested inside a <button>.
  const markerPicker = pickingMarker && markerMode !== 'off' && (
    <Suspense fallback={null}>
      <MarkerPickerModal
        title={title}
        current={explicitMarker}
        autoKey={git?.branch || meta.cwd}
        mode={markerMode}
        usedMarkers={takenMarkers}
        onPick={(next) => {
          useSessionsStore.getState().setLaneMarker(meta.path, next)
          setPickingMarker(false)
        }}
        onClose={() => setPickingMarker(false)}
      />
    </Suspense>
  )

  if (renaming) {
    return (
      <>
        <div
          data-testid="session-row"
          data-workspace={rowWorkspaceName}
          data-activity={activity}
          data-deleting={deleting || undefined}
          aria-disabled={deleting}
          className={rowClassName}
        >
          {body}
        </div>
        {markerPicker}
      </>
    )
  }

  return (
    <>
      <LaneRow
        onClick={open}
        {...menu}
        onDoubleClick={beginRename}
        disabled={deleting}
        aria-busy={deleting}
        data-testid="session-row"
        data-workspace={rowWorkspaceName}
        data-activity={activity}
        data-deleting={deleting || undefined}
        tooltip={deleting ? 'Deleting lane' : title}
        title={
          deleting
            ? 'This lane is being deleted'
            : meta.branchCount > 0
              ? `${meta.branchCount + 1} branches`
              : undefined
        }
        className={rowClassName}
      >
        {body}
      </LaneRow>
      {markerPicker}
    </>
  )
}

/**
 * The inline rename field, shared by both row types.
 *
 * Shared rather than duplicated for the same reason the subtitle is: a live
 * session swaps from `PendingSessionRow` to `SessionRow` mid-turn, and the
 * editor must not change shape under the caret when it does.
 */
function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <input
      autoFocus
      // Pre-selected: a double-click rename usually replaces the whole
      // generated title rather than editing a word of it.
      onFocus={(e) => e.target.select()}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') onCancel()
      }}
      aria-label="Session name"
      className="border-border focus:border-accent block w-full min-w-0 rounded border bg-transparent px-1 py-px text-base leading-4 outline-none"
      data-tooltip="Session name"
    />
  )
}

/**
 * Row for a live session that has no session file yet.
 *
 * Deliberately not a `SessionRow`: most actions there are keyed on
 * `meta.path` (fork, pin, lane marker, open-from-disk), and this
 * session may have no path to act on. Rename and export use the live process.
 * Delete uses its handle, stopping it even if no transcript was ever saved. They
 * used to be missing entirely, which made a session unrenameable for the
 * whole of its first turn: exactly the minutes when its name is still a
 * placeholder and the user most wants to fix it.
 *
 * **Replaced mid-turn.** pi writes a session's file when the first message
 * is sent, so this row stands in until the folder watcher reports it, usually
 * while the first reply is still streaming, and is then replaced by a
 * `SessionRow`. That swap has to be
 * invisible, which is why the subtitle below is the same `time · wt · branch`
 * shape the disk-backed row uses rather than the "naming…" / "starting…" text
 * it used to show. Two different subtitles on one row within a few seconds
 * read as the row being replaced, which is exactly what was happening.
 */
function PendingSessionRow({
  phosphorId,
  active,
  git,
  onDelete,
}: {
  phosphorId: string
  active: boolean
  git?: GitInfo
  onDelete: (title: string) => void
}): React.JSX.Element {
  const orderActions = useSessionOrderActions()
  const isStreaming = useChatStore((s) => s.sessions[phosphorId]?.isStreaming ?? false)
  const delegated = useExtensionUiStore((s) =>
    hasDelegatedWork(s.widgets[phosphorId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines),
  )
  const booting = useSessionBooting(phosphorId)
  const activity = isStreaming || delegated ? 'working' : booting ? 'starting' : undefined
  const firstUserText = useChatStore(
    (s) => s.sessions[phosphorId]?.items.find((item) => item.kind === 'user')?.text,
  )
  const explicitName = useChatStore((s) => s.sessions[phosphorId]?.meta?.sessionName)
  const naming = useNameTransition(phosphorId)
  const title = sessionTitle({ explicitName, firstUserText }, { elide: false }) ?? 'New session'
  // No invented timestamp: this can be an old orphan, not a new session.
  const subtitle = sessionSubtitle({}, git)
  const deleting = useSessionsStore(
    (s) =>
      s.deletingSessionKeys.includes(phosphorId) ||
      Boolean(
        s.live[phosphorId]?.diskPath &&
        s.deletingSessionKeys.includes(s.live[phosphorId]!.diskPath!),
      ),
  )
  // The marker slot has to be here too, and derived the same way. This row is
  // swapped for a real SessionRow the moment the session file lands, and a
  // slot that appeared only after the swap would shift the title mid-turn —
  // the exact twitch the shared subtitle above exists to avoid. There is no
  // meta.path yet, so there can be no explicit override: always Auto.
  const markerMode = useLanePrefsStore((s) => s.lanes.markers)
  const marker = laneMarker(undefined, git?.branch, null, markerMode)

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const beginRename = (): void => {
    setRenameValue(title)
    setRenaming(true)
  }

  const applyRename = (): void => {
    const name = committedRename(renameValue, title)
    setRenaming(false)
    if (!name) return
    // No `refreshDisk` follow-up, unlike the disk-backed row: there is no file
    // to rescan yet. `applySessionRename` patches the chat store, and this
    // row's title reads that store, so the new name shows immediately and
    // survives the swap to `SessionRow` (which prefers the live name too).
    void applySessionRename(phosphorId, name)
  }
  const menuItems = (): ContextMenuItem[] => {
    return [
      { label: 'Open', onClick: () => void navigateToLane({ sessionId: phosphorId }) },
      ...orderActions,
      { label: 'Rename…', onClick: beginRename },
      { label: 'Export HTML…', onClick: () => void exportSessionHtml(phosphorId, title) },
      {
        label: 'Delete',
        danger: true,
        separatorAbove: true,
        disabled: deleting,
        onClick: () => onDelete(title),
      },
    ]
  }
  const menu = useMenuTriggers(menuItems, { title })

  const className = clsx(
    'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
    // Same treatment as SessionRow — see the comment there. It must match
    // exactly: this row is replaced by a real SessionRow the moment the
    // session file lands, and any difference reads as the row twitching.
    active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
  )

  const body = (
    <>
      <SessionIndicator state={activity ? 'streaming' : 'live'} />
      {markerMode !== 'off' && <LaneMarker marker={marker} />}
      <span className="min-w-0 flex-1">
        {renaming ? (
          <RenameInput
            value={renameValue}
            onChange={setRenameValue}
            onCommit={applyRename}
            onCancel={() => {
              setRenaming(false)
              setRenameValue('')
            }}
          />
        ) : (
          <span
            key={title}
            data-tooltip={naming.pending ? 'Naming this chat…' : title}
            data-testid="session-title"
            className={clsx(
              SESSION_TITLE_CLASS,
              // See SessionRow: shimmers while pending too, must match exactly —
              // this row is swapped for a real SessionRow mid-shimmer the moment
              // the session file lands, and any difference reads as a twitch.
              naming.pending && 'name-pending',
              naming.settled && 'name-enter',
            )}
          >
            {title}
          </span>
        )}
        <span
          className={clsx(
            'flex items-center gap-1 text-base leading-4',
            active ? 'text-text' : 'text-text-secondary',
          )}
        >
          <SubtitleSegments segments={subtitle} activity={activity} />
        </span>
      </span>
    </>
  )

  // A <div> while editing, for the same reason SessionRow swaps its tag: a
  // text field inside a <button> is invalid HTML and Enter belongs to the
  // button, not the field.
  if (renaming) {
    return (
      <div
        data-testid="session-row"
        data-pending="true"
        data-activity={activity}
        className={className}
      >
        {body}
      </div>
    )
  }

  return (
    <TooltipButton
      onClick={() => void navigateToLane({ sessionId: phosphorId })}
      disabled={deleting}
      aria-busy={deleting}
      {...menu}
      onDoubleClick={beginRename}
      data-testid="session-row"
      data-pending="true"
      tooltip={deleting ? 'Deleting lane' : title}
      data-activity={activity}
      className={className}
    >
      {body}
    </TooltipButton>
  )
}

/**
 * The `2m · wt · ⎇ branch · ±3 · $1.24` run under a session's title.
 *
 * Shared by `SessionRow` and `PendingSessionRow` rather than duplicated,
 * because a live session swaps from the second to the first mid-turn and the
 * swap has to be invisible. They had drifted into two different subtitles.
 */

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary px-2 pb-0.5 pt-2.5 text-xs font-semibold font-mono uppercase tracking-wider">
      {children}
    </div>
  )
}

/**
 * Placeholder headers for the whole group list, before prefs have landed.
 *
 * Distinct from `SessionRowSkeletons`, which stands in for the sessions
 * *inside* a group whose folders are known. This one covers the earlier
 * window, when which projects exist and what order they take is still
 * unknown, and painting a real header means painting one that may vanish.
 */
function WorkspaceGroupSkeletons(): React.JSX.Element {
  return (
    <div data-testid="workspace-groups-loading" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="px-2 pb-0.5 pt-2.5">
            <div
              className="bg-sidebar-hover h-3 animate-pulse rounded"
              style={{ width: `${45 - i * 10}%` }}
            />
          </div>
          <SessionRowSkeletons />
        </div>
      ))}
    </div>
  )
}

/**
 * Placeholder rows for a group whose folders have not been scanned yet.
 *
 * Replaces a single "Loading sessions…" line: the line was indistinguishable
 * from the empty state one character at a time, and gave no sense of a list
 * arriving.
 */
function SessionRowSkeletons(): React.JSX.Element {
  return (
    <div className="space-y-2 px-2 py-2" data-testid="sessions-loading" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1">
          <div
            className="bg-sidebar-hover h-3 animate-pulse rounded"
            style={{ width: `${70 - i * 12}%` }}
          />
          <div className="bg-sidebar-hover h-2 w-1/3 animate-pulse rounded opacity-60" />
        </div>
      ))}
    </div>
  )
}
