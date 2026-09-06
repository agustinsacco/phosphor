import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { GitInfo, SessionMeta, WorktreeInfo } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { useSessionsStore } from '@/stores/sessions'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useChatStore } from '@/stores/chat'
import { useSessionBooting } from '@/features/chat/BootingIndicator'
import { showContextMenu } from '@/components/ContextMenu'
import { isUnseen } from './unseen'
import { sessionSubtitle, type SubtitleSegment } from './sessionSubtitle'
import { PrBadge, openPullRequest } from './PrBadge'
import { LaneMarker } from './LaneMarker'
import { MarkerPickerModal } from './MarkerPickerModal'
import { BulkDeleteModal, BulkDeleteProgressModal } from './BulkDeleteModal'
import { classifyLane, summarizePreflight, type PreflightSummary } from './deletePreflight'
import { laneMarker } from '@/lib/laneMarker'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore, pullRequestFor } from '@/stores/pullRequests'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import {
  ArtifactsIcon,
  SkillsIcon,
  ChevronDownIcon,
  ChevronIcon,
  GearIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
} from '@/components/icons'
import { PiSpark } from '@/components/PiSpark'
import { TreeViewModal } from './TreeViewModal'
import { LaneSearchBar } from './LaneSearchBar'
import { laneHaystack, laneMatches, laneQueryTerms, type LaneSearchFields } from './laneSearch'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { UpdatePill } from '@/features/updates/UpdatePill'
import { formatShortcut } from '@/lib/shortcuts'
import { useLayoutStore } from '@/stores/layout'
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

const SIDEBAR_WIDTH_KEY = 'pidex:sidebarWidth'
const SIDEBAR_MIN = 208
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 256

function loadSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(stored) || stored === 0) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored))
}

export function Sidebar({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const disk = useSessionsStore((s) => s.disk)
  const scanStatus = useSessionsStore((s) => s.scanStatus)
  const live = useSessionsStore((s) => s.live)
  const unread = useSessionsStore((s) => s.unread)
  const pinned = useSessionsStore((s) => s.pinned)
  const seenSessions = useSessionsStore((s) => s.seenSessions)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const activePage = useLayoutStore((s) => s.page)
  const recents = useWorkspacesStore((s) => s.recents)
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
  const [worktreeDirs, setWorktreeDirs] = useState<{ path: string; root: string }[]>([])
  const [workspaceMenuFor, setWorkspaceMenuFor] = useState<string | null>(null)
  const workspaceMenuTriggerRef = useRef<HTMLButtonElement>(null)
  /** Which group's "Delete sandbox…" row is waiting for its second click. */
  const [confirmSandboxDelete, setConfirmSandboxDelete] = useState<string | null>(null)
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  const sandboxPaths = useMemo(() => new Set(sandboxes.map((sandbox) => sandbox.path)), [sandboxes])
  const closeWorkspaceMenu = (): void => {
    setWorkspaceMenuFor(null)
    setConfirmSandboxDelete(null)
  }
  /** Which roots we already listed worktrees for (avoids re-listing on toggle). */
  const worktreeListedKey = useRef<string | null>(null)

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
    paths.add(workspacePath)
    for (const entry of Object.values(live)) paths.add(entry.workspacePath)
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
    const store = useSessionsStore.getState()
    void store.refreshAllDisk(knownWorkspaces)
    void store.hydratePinned()

    const unsubscribe = window.pidex.onSessionsChanged((payload) => {
      // Re-scan only the workspace that actually changed.
      void useSessionsStore.getState().refreshDisk(payload.workspacePath)
    })
    return unsubscribe
  }, [knownWorkspaces])

  useEffect(() => {
    void window.pidex.invoke('app:getPrefs').then((prefs) => {
      setCollapsed(Object.fromEntries(prefs.collapsedWorkspaces.map((p) => [p, true])))
    })
  }, [])

  /**
   * Discover the worktree folders under each known repo workspace.
   *
   * Worktrees are not persisted as workspaces (they are branches of one), so
   * the sidebar would otherwise never scan them and their sessions would
   * vanish from the project group they fold into. Listing each known working
   * tree restores them; the merge in `groupSessionsByProject` puts every one
   * back under its main repo's header.
   */
  useEffect(() => {
    // Wait for prefs hydration, and only list once per set of known roots —
    // expanding/collapsing a group must not re-run a full `git:listWorktrees`
    // per workspace.
    if (collapsed === null) return
    const roots = [...cleanRecents.map((ws) => ws.path), workspacePath].filter(
      (p) => Boolean(p) && !isWorktreeFolder(p!),
    )
    // Starting a lane does not touch `recents` (worktrees are deliberately
    // never persisted there), so a roots-only key never re-listed and a lane
    // was visible only for as long as its session stayed live. Folding the
    // count of live-but-undiscovered lanes into the key re-lists once when one
    // appears; the next pass finds it, the count returns to zero, and the key
    // settles.
    const key = [...roots, `lanes:${unknownLanes}`].join('\u0000')
    if (worktreeListedKey.current === key) return
    worktreeListedKey.current = key
    let cancelled = false
    void (async () => {
      const found = new Map<string, string>()
      for (const root of roots) {
        if (cancelled) return
        try {
          const worktrees = (await window.pidex.invoke('git:listWorktrees', root)) as WorktreeInfo[]
          for (const wt of worktrees) {
            // `prunable` is git's own answer for "this folder is gone". A
            // deleted worktree is still listed until someone prunes it, and
            // without this it became a sidebar group for a directory that
            // does not exist.
            if (wt.isMain || wt.prunable) continue
            found.set(wt.realPath || wt.path, root!)
          }
        } catch {
          // Not a repo, or git unavailable — nothing to discover there.
        }
      }
      if (!cancelled) setWorktreeDirs([...found].map(([path, root]) => ({ path, root })))
    })()
    return () => {
      cancelled = true
    }
  }, [cleanRecents, workspacePath, collapsed, unknownLanes])

  // Git summaries for row subtitles: refresh (debounced) whenever the disk
  // listing changes, and again on window focus (branch switches happen in
  // terminals pidex can't observe).
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
      if (entry.diskPath) map.set(entry.diskPath, entry.pidexId)
    }
    return map
  }, [live])

  const pinnedSet = useMemo(() => new Set(pinned), [pinned])

  /** Pinned sessions across every workspace — this group deliberately mixes. */
  const pinnedMetas = useMemo(
    () =>
      Object.values(disk)
        .flat()
        .filter((m) => pinnedSet.has(m.path))
        .sort(compareSessionsByCreation),
    [disk, pinnedSet],
  )

  /**
   * Remaining sessions grouped by *project*, live projects first.
   *
   * A linked worktree is a different folder from its main repo, so without
   * this merge step every worktree got its own header ("pidex", "pidex
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
        (m) => pinnedSet.has(m.path),
        (m) => liveByDisk.has(m.path),
        workspacePath,
        scanStatus,
        worktreeRoots,
      ),
    [
      knownWorkspaces,
      disk,
      gitByCwd,
      scanStatus,
      pinnedSet,
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
   * PR chips: one `gh` subprocess per EXPANDED group, never one per lane.
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
  const openBulkDelete = (): void => {
    if (!selection) return
    const chat = useChatStore.getState()
    const sessions = useSessionsStore.getState()
    const prState = usePullRequestsStore.getState()
    const markerPrefMode = useLanePrefsStore.getState().lanes.markers
    const metaByPath = new Map(
      Object.values(disk)
        .flat()
        .map((meta) => [meta.path, meta] as const),
    )

    const lanes = selection.paths.flatMap((path) => {
      const meta = metaByPath.get(path)
      if (!meta) return []
      const livePidexId = liveByDisk.get(path)
      const git = gitByCwd[meta.cwd || workspacePath]
      const liveName = livePidexId ? chat.sessions[livePidexId]?.meta?.sessionName : undefined
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
          isLive: Boolean(livePidexId),
          isStreaming: livePidexId ? (chat.sessions[livePidexId]?.isStreaming ?? false) : false,
        }),
      ]
    })
    setPendingDelete(summarizePreflight(lanes))
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
    void window.pidex.invoke(
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
   * Names of live sessions, which can lead their file on disk by a whole turn
   * (pi writes a session file only when a turn ENDS). Without them, a lane
   * renamed mid-turn is not findable under the name the sidebar is showing.
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
    const livePidexId = liveByDisk.get(meta.path)
    const liveName = livePidexId ? liveNames.get(livePidexId) : undefined
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

  const groupContextMenu = (event: React.MouseEvent, group: GroupedSessions): void => {
    const git = gitByCwd[group.workspacePath]
    const openWorktreeModal = async (kind: 'remove' | 'merge'): Promise<void> => {
      const repoPath = git?.mainRepoPath
      if (!repoPath) return
      const worktrees = await window.pidex.invoke('git:listWorktrees', repoPath)
      const worktree = worktrees.find(
        (w) => w.path === group.workspacePath || w.realPath === group.workspacePath,
      )
      if (worktree) setWorktreeModal({ kind, repoPath, worktree })
    }
    showContextMenu(event, [
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
    ])
  }

  const moveGroup = (group: GroupedSessions, direction: 'up' | 'down'): void => {
    // A merged worktree group is represented by its main-repo workspace path,
    // which is the entry the user sees and orders in the sidebar.
    useWorkspacesStore.getState().moveWorkspace(group.workspacePath, direction)
    closeWorkspaceMenu()
  }

  const rowProps = (meta: SessionMeta) => {
    const livePidexId = liveByDisk.get(meta.path)
    const active = livePidexId === activeSessionId && activeSessionId !== null
    return {
      meta,
      workspacePath: meta.cwd || workspacePath,
      livePidexId,
      active,
      unseen:
        !active &&
        ((unread[livePidexId ?? ''] ?? 0) > 0 ||
          isUnseen(seenSessions, meta.path, meta.lastActivityAt)),
      git: gitByCwd[meta.cwd || workspacePath],
      onOpenTree: () => setTreeFor(meta),
    }
  }

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
          onClick={() => useSessionsStore.getState().activate(null)}
          icon={<PlusIcon strokeWidth={2.5} />}
        />
        <NavRow
          label="Artifacts"
          active={activePage === 'artifacts'}
          onClick={() => useLayoutStore.getState().togglePage('artifacts')}
          icon={<ArtifactsIcon />}
        />
        <NavRow
          label="Skills"
          active={activePage === 'skills'}
          onClick={() => useLayoutStore.getState().togglePage('skills')}
          icon={<SkillsIcon />}
        />
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {pinnedMetas.length > 0 && (
          <>
            <SectionLabel>Pinned</SectionLabel>
            {pinnedMetas.map((meta) => (
              <SessionRow key={meta.path} {...rowProps(meta)} isPinned showWorkspace />
            ))}
          </>
        )}

        {/* Prefs decide both which workspaces exist and what order they sit
            in, so any header painted before they land can be wrong or about
            to jump. A skeleton is the honest answer for that window. */}
        {collapsed === null && <WorkspaceGroupSkeletons />}

        {collapsed !== null &&
          groups.map((group) => {
            const isCollapsed = isGroupCollapsed(group)
            const query = searchApplied[group.workspacePath] ?? ''
            const terms = laneQueryTerms(query)
            // Filter the metas rather than hide rows: selection, shift-ranges
            // and the empty state then all read the same list the eye does.
            const visible = terms.length
              ? group.metas.filter((meta) => laneMatches(laneHaystack(laneFields(meta)), terms))
              : group.metas
            const selectingThis = selection?.repoPath === group.workspacePath
            return (
              <div key={group.workspacePath}>
                <div
                  onContextMenu={(event) => groupContextMenu(event, group)}
                  className="group/header relative flex w-full items-center gap-1 pb-0.5 pl-2 pr-1 pt-2.5"
                >
                  <button
                    onClick={() => toggleGroup(group, isCollapsed)}
                    data-testid="workspace-group"
                    className="text-text-secondary hover:text-text flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-sm font-semibold font-mono uppercase tracking-wider transition-colors"
                    title={group.workspacePath}
                  >
                    <span className="min-w-0 truncate">{group.name}</span>
                    <ChevronIcon
                      size={8}
                      strokeWidth={3}
                      expanded={!isCollapsed}
                      className={clsx(
                        'shrink-0 transition-opacity',
                        // Collapsed groups keep their caret as the "there's more
                        // here" cue; expanded ones reveal it on hover only.
                        !isCollapsed && 'opacity-0 group-hover/header:opacity-100',
                      )}
                    />
                    {group.liveCount > 0 && (
                      <span
                        className="bg-success h-1.5 w-1.5 shrink-0 rounded-full"
                        title={`${group.liveCount} live`}
                      />
                    )}
                  </button>
                  <button
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
                  </button>
                  <button
                    ref={
                      workspaceMenuFor === group.workspacePath ? workspaceMenuTriggerRef : undefined
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
                  </button>
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
                      {/* Only a sandbox is deletable from here: it is pidex's
                          own scratch folder, so removing it is ours to offer.
                          A project folder is the user's and is only ever
                          forgotten, in Settings. */}
                      {sandboxPaths.has(group.workspacePath) && (
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
                            void useWorkspacesStore.getState().deleteSandbox(group.workspacePath)
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
                      )}
                    </PopupMenu>
                  )}
                  <button
                    onClick={() => {
                      useWorkspacesStore.getState().openWorkspace(group.workspacePath)
                      useSessionsStore.getState().activate(null)
                    }}
                    data-testid="workspace-group-new-session"
                    title="New session here"
                    className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors active:scale-90"
                  >
                    <PlusIcon size={12} strokeWidth={2.5} />
                  </button>
                </div>
                {isSearching(group) && (
                  <LaneSearchBar
                    value={searchDraft[group.workspacePath] ?? ''}
                    applied={Boolean(query)}
                    matchCount={visible.length}
                    total={group.metas.length}
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
                {!isCollapsed &&
                  terms.length === 0 &&
                  (pendingByWorkspace.get(group.workspacePath) ?? []).map((pidexId) => (
                    <PendingSessionRow
                      key={pidexId}
                      pidexId={pidexId}
                      active={pidexId === activeSessionId}
                      git={gitByCwd[live[pidexId]?.workspacePath ?? '']}
                    />
                  ))}
                {!isCollapsed &&
                  visible.map((meta) => (
                    <SessionRow
                      key={meta.path}
                      {...rowProps(meta)}
                      isPinned={false}
                      selected={selection?.paths.includes(meta.path) === true && selectingThis}
                      selecting={selectingThis}
                      onToggleSelect={(shiftKey) =>
                        toggleLaneSelection(group, visible, meta.path, shiftKey)
                      }
                    />
                  ))}
                {!isCollapsed && group.metas.length > 0 && visible.length === 0 && (
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
                {!isCollapsed && group.metas.length > 0 && group.unscannedPaths.length > 0 && (
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
                      <button
                        onClick={() => retryGroup(group)}
                        className="text-text-secondary hover:text-text rounded px-1 underline-offset-2 hover:underline"
                      >
                        Retry
                      </button>
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

      <div className="border-border border-t px-3 py-2">
        <UpdatePill />
        <button
          onClick={() => useSettingsUiStore.getState().setOpen(true)}
          className="text-text-secondary hover:text-text hover:bg-sidebar-hover -mx-1 flex w-[calc(100%+8px)] items-center gap-2 rounded-md px-1.5 py-1 text-base transition-colors"
          title={`Settings (${formatShortcut('mod', ',')})`}
        >
          <GearIcon /> Settings
        </button>
      </div>

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
          <button
            onClick={openBulkDelete}
            className="bg-danger rounded-md px-2.5 py-1 text-xs font-semibold text-white"
          >
            Delete…
          </button>
          <button
            onClick={clearSelection}
            className="border-border text-text-secondary hover:text-text rounded-md border px-2.5 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
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
            // The dialog stays up and switches to its progress view; the store
            // publishes each lane as it goes. Clearing the selection now would
            // empty the list the progress view is describing, so it waits
            // until the run is dismissed.
            setPendingDelete(null)
            void useSessionsStore.getState().deleteManySessions(workspacePath, lanes, options)
          }}
        />
      )}

      <BulkDeleteProgressModal onDone={clearSelection} />

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
  const recents = useWorkspacesStore((s) => s.recents)
  const git = useSessionsStore((s) => (currentPath ? s.gitByCwd[currentPath] : undefined))
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Project only, no branch: the top bar's folder and branch chips sit a row
  // above this and already answer "where am I". Showing `pidex (pidex/hey-2)`
  // here as well put the branch on screen twice and the folder twice.
  const name = currentPath ? projectName(currentPath, git) : 'Workspace'

  return (
    // Draggable: on Windows/Linux this row sits flush against the top of the
    // window (there is no traffic-light strip above it), so it is the only
    // grab handle the sidebar has. The trigger and the menu opt back out.
    <div className="titlebar-drag relative px-3 pb-1.5 pt-1">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="workspace-switcher"
        className="hover:bg-sidebar-hover flex w-full items-center gap-2 rounded-md px-2 py-1 transition-colors"
      >
        <span className="bg-accent-soft text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base font-bold uppercase">
          {name.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-lg font-semibold">{name}</span>
        <ChevronDownIcon className="text-text-tertiary shrink-0" />
      </button>

      {open && (
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

const SESSION_TITLE_CLASS = 'text-text line-clamp-2 break-words text-lg font-medium leading-5'

function SessionRow({
  meta,
  workspacePath,
  livePidexId,
  active,
  unseen,
  git,
  isPinned,
  showWorkspace = false,
  onOpenTree,
  selected = false,
  selecting = false,
  onToggleSelect,
}: {
  meta: SessionMeta
  workspacePath: string
  livePidexId?: string
  active: boolean
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
}): React.JSX.Element {
  const isStreaming = useChatStore((s) =>
    livePidexId ? (s.sessions[livePidexId]?.isStreaming ?? false) : false,
  )
  // Prompt sent, pi not started yet: the row pulses like a streaming one, or
  // a lane that is genuinely booting reads as idle in the list.
  const booting = useSessionBooting(livePidexId)
  const isSuspended = useSessionsStore((s) => s.suspendedPaths.includes(meta.path))
  // A worktree lane's PRs live under the MAIN repo, which is also the key the
  // sidebar group and `gh:prsForRepo` use. Derived here rather than threaded
  // through `rowProps` so a Pinned row — which may belong to a different
  // project than the one on screen — still resolves against its own repo.
  const repoPath = git?.mainRepoPath ?? meta.cwd ?? workspacePath
  const pullRequest = usePullRequestsStore((s) => pullRequestFor(s, repoPath, git?.branch))
  const showPrStatus = useLanePrefsStore((s) => s.lanes.prStatus)
  // "No PR yet" is inferred, not reported by gh, so it needs its own gate: only
  // once a fetch for this repo has actually completed (never for gh missing /
  // unauthenticated / no GitHub remote, which all land as the same empty map —
  // see gh-cli.ts), and only for a worktree lane. A non-worktree branch (most
  // commonly the trunk itself) is not "a lane" in the PR sense, and inferring
  // "you could open a PR" there is far more often wrong than right.
  const ghCliAvailable = usePullRequestsStore((s) => s.available)
  const prFetchedAt = usePullRequestsStore((s) => s.byRepo[repoPath]?.fetchedAt ?? 0)
  const confirmedNoPr =
    !pullRequest && Boolean(git?.isWorktree) && ghCliAvailable === true && prFetchedAt > 0
  // Cost only steps aside for a chip that is actually about to render. A
  // non-worktree branch with no confirmed PR gets neither — gating this on
  // the raw preference instead would blank the trailer on every plain-main
  // session the moment the flag is on, which is strictly worse than the cost
  // it replaced.
  const showChip = showPrStatus && Boolean(pullRequest || confirmedNoPr)
  const explicitMarker = useSessionsStore((s) => s.laneMarkers[meta.path])
  const markerMode = useLanePrefsStore((s) => s.lanes.markers)
  // Keyed on the branch, not the title: pidex names a session only after its
  // first turn ends, so a title-derived marker would change under the user the
  // moment the auto-namer landed.
  const marker = laneMarker(explicitMarker, git?.branch, meta.cwd, markerMode)
  const naming = useNameTransition(livePidexId)
  // A live session's own name beats the scanned one. pi writes its session
  // file only when a turn ENDS (measured), so a name set mid-turn does not
  // reach `meta.name` until the reply lands — sometimes minutes later. The
  // top bar reads the live store and would rename while this row did not.
  const liveName = useChatStore((s) =>
    livePidexId ? s.sessions[livePidexId]?.meta?.sessionName : undefined,
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
    void renameSidebarSession(workspacePath, meta, name, livePidexId)
  }

  const cancelRename = (): void => {
    setRenaming(false)
    setRenameValue('')
  }
  // Badge reads the session's own cwd, so a Pinned row shows the project it
  // actually belongs to rather than whatever is on screen. Project only — the
  // subtitle beneath it already carries `wt` and the branch.
  const rowWorkspaceName = projectName(meta.cwd || workspacePath, git)

  const open = (): void => {
    void useSessionsStore.getState().openDiskSession(workspacePath, meta)
  }

  const contextMenu = (event: React.MouseEvent): void => {
    const store = useSessionsStore.getState()
    showContextMenu(event, [
      { label: 'Open', onClick: open },
      { label: 'Session tree…', onClick: onOpenTree },
      {
        label: isPinned ? 'Unpin' : 'Pin',
        onClick: () => store.togglePin(meta.path),
      },
      ...(markerMode === 'off'
        ? []
        : [{ label: 'Lane marker…', onClick: () => setPickingMarker(true) }]),
      // The chip itself is a mouse-only shortcut (it cannot be a tab stop
      // inside the row button — see PrBadge). This is the keyboard route, and
      // the only way to discover the PR number without hovering.
      ...(pullRequest
        ? [
            {
              label: `Open pull request #${pullRequest.number}`,
              hint: pullRequest.state.toLowerCase(),
              onClick: () => void openPullRequest(pullRequest),
            },
          ]
        : []),
      ...(livePidexId
        ? [
            {
              label: 'Suspend',
              hint: '~200 MB',
              onClick: () => void store.suspendSession(livePidexId),
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
        onClick: () => void cloneSession(workspacePath, meta, livePidexId),
      },
      {
        label: 'Export HTML…',
        onClick: () => void exportSidebarSession(workspacePath, meta, livePidexId),
      },
      {
        label: 'Copy debug info',
        onClick: () => void copySessionDebugInfo(meta, livePidexId),
      },
      {
        label: 'Delete',
        hint: 'to trash',
        danger: true,
        separatorAbove: true,
        onClick: () => void store.deleteDiskSession(workspacePath, meta),
      },
    ])
  }

  const subtitle = sessionSubtitle(meta, git, { showCost: !showChip })
  const indicatorState =
    isStreaming || booting ? 'streaming' : unseen ? 'unseen' : livePidexId ? 'live' : 'disk'

  const rowClassName = clsx(
    'group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
    // Active = the row on screen, and a plain fill is the whole signal.
    //
    // This used to be a 2px accent rail plus a `bg-bg-secondary` fill, because
    // that fill was invisible in light mode — `--px-bg-secondary` sits on the
    // *lighter* side of the sidebar ground. The rail was a workaround, and on
    // a `rounded-lg` row it followed the corner radius and rendered as an
    // amber crescent down the left edge rather than a straight line.
    //
    // Fixed at the token instead: `sidebar-active` / `sidebar-hover` move away
    // from the sidebar in whichever direction the theme needs. The fill alone
    // is then legible in both modes, so the rail is gone, the radius is a
    // step squarer, and the left edge is flush again. State (live, streaming,
    // unseen) stays the indicator dot's job — see SessionIndicator.
    active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
    selected && 'bg-accent-soft',
  )

  const body = (
    <>
      {onToggleSelect ? (
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
            'grid size-4 shrink-0 place-items-center rounded-[4px] border text-2xs',
            selected
              ? 'bg-accent border-accent text-accent-text'
              : 'border-border-strong bg-surface',
            !selected && !selecting && 'hidden group-hover:grid',
          )}
        >
          {selected ? '✓' : ''}
        </span>
      ) : null}
      <span className={clsx(onToggleSelect && (selecting ? 'hidden' : 'group-hover:hidden'))}>
        <SessionIndicator state={indicatorState} />
      </span>
      {markerMode !== 'off' && <LaneMarker marker={marker} />}
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
            title={naming.pending ? 'Naming this chat…' : title}
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
              title="Process released to save memory. Opening this session resumes it from disk."
            >
              suspended
            </span>
          )}
          <SubtitleSegments segments={subtitle} />
          {showChip && <PrBadge pr={pullRequest ?? null} />}
        </span>
      </span>
      {showWorkspace && rowWorkspaceName && (
        <span
          data-testid="session-workspace-badge"
          title={meta.cwd || workspacePath}
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
  const markerPicker = pickingMarker && (
    <MarkerPickerModal
      title={title}
      current={explicitMarker}
      autoKey={git?.branch || meta.cwd}
      usedMarkers={takenMarkers}
      onPick={(next) => {
        useSessionsStore.getState().setLaneMarker(meta.path, next)
        setPickingMarker(false)
      }}
      onClose={() => setPickingMarker(false)}
    />
  )

  if (renaming) {
    return (
      <>
        <div data-testid="session-row" data-workspace={rowWorkspaceName} className={rowClassName}>
          {body}
        </div>
        {markerPicker}
      </>
    )
  }

  return (
    <>
      <button
        onClick={open}
        onContextMenu={contextMenu}
        onDoubleClick={beginRename}
        data-testid="session-row"
        data-workspace={rowWorkspaceName}
        title={meta.branchCount > 0 ? `${meta.branchCount + 1} branches` : undefined}
        className={rowClassName}
      >
        {body}
      </button>
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
    />
  )
}

/**
 * Row for a live session that has no session file yet.
 *
 * Deliberately not a `SessionRow`: most actions there are keyed on
 * `meta.path` (fork, delete, pin, lane marker, open-from-disk), and this
 * session has no path to act on. What it CAN do is everything routed through
 * the live pi process instead — rename and export — so those are here. They
 * used to be missing entirely, which made a session unrenameable for the
 * whole of its first turn: exactly the minutes when its name is still a
 * placeholder and the user most wants to fix it.
 *
 * **Not short-lived.** pi writes a session's file only when a turn ENDS
 * (measured), so this row stands in for the entire first turn — minutes, for
 * real work — and is then replaced by a `SessionRow`. That swap has to be
 * invisible, which is why the subtitle below is the same `time · wt · branch`
 * shape the disk-backed row uses rather than the "naming…" / "starting…" text
 * it used to show. Two different subtitles on one row within a few seconds
 * read as the row being replaced, which is exactly what was happening.
 */
function PendingSessionRow({
  pidexId,
  active,
  git,
}: {
  pidexId: string
  active: boolean
  git?: GitInfo
}): React.JSX.Element {
  const isStreaming = useChatStore((s) => s.sessions[pidexId]?.isStreaming ?? false)
  const booting = useSessionBooting(pidexId)
  const firstUserText = useChatStore(
    (s) => s.sessions[pidexId]?.items.find((item) => item.kind === 'user')?.text,
  )
  const explicitName = useChatStore((s) => s.sessions[pidexId]?.meta?.sessionName)
  const naming = useNameTransition(pidexId)
  const title = sessionTitle({ explicitName, firstUserText }, { elide: false }) ?? 'New session'
  // Synthesised meta so this row and the disk-backed one format their
  // subtitle through the same function. Created now, nothing spent yet.
  const subtitle = sessionSubtitle({ mtimeMs: Date.now(), cost: 0 }, git)
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
    void applySessionRename(pidexId, name)
  }

  const contextMenu = (event: React.MouseEvent): void => {
    showContextMenu(event, [
      { label: 'Open', onClick: () => useSessionsStore.getState().activate(pidexId) },
      { label: 'Rename…', onClick: beginRename },
      { label: 'Export HTML…', onClick: () => void exportSessionHtml(pidexId, title) },
    ])
  }

  const className = clsx(
    'group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
    // Same treatment as SessionRow — see the comment there. It must match
    // exactly: this row is replaced by a real SessionRow the moment the
    // session file lands, and any difference reads as the row twitching.
    active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
  )

  const body = (
    <>
      <SessionIndicator state={isStreaming || booting ? 'streaming' : 'live'} />
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
            title={naming.pending ? 'Naming this chat…' : title}
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
          <SubtitleSegments segments={subtitle} />
        </span>
      </span>
    </>
  )

  // A <div> while editing, for the same reason SessionRow swaps its tag: a
  // text field inside a <button> is invalid HTML and Enter belongs to the
  // button, not the field.
  if (renaming) {
    return (
      <div data-testid="session-row" data-pending="true" className={className}>
        {body}
      </div>
    )
  }

  return (
    <button
      onClick={() => useSessionsStore.getState().activate(pidexId)}
      onContextMenu={contextMenu}
      onDoubleClick={beginRename}
      data-testid="session-row"
      data-pending="true"
      className={className}
    >
      {body}
    </button>
  )
}

/**
 * The `2m · wt · ⎇ branch · ±3 · $1.24` run under a session's title.
 *
 * Shared by `SessionRow` and `PendingSessionRow` rather than duplicated,
 * because a live session swaps from the second to the first mid-turn and the
 * swap has to be invisible. They had drifted into two different subtitles.
 */
function SubtitleSegments({ segments }: { segments: SubtitleSegment[] }): React.JSX.Element {
  return (
    <>
      {segments.map((segment, i) => (
        <span
          key={segment.key}
          className={clsx(
            'flex items-center',
            // The branch is the only segment allowed to give up space.
            // Both classes set flex-shrink, so they must be exclusive:
            // emitting `shrink-0 shrink` let source order decide and
            // `shrink-0` won, which is what pushed long branch names past
            // the sidebar edge and produced a horizontal scrollbar.
            segment.truncate ? 'min-w-0 shrink' : 'shrink-0',
          )}
        >
          {i > 0 && <span className="pr-1">·</span>}
          {segment.key === 'worktree' ? (
            <span
              className="bg-chip text-text-secondary rounded px-1 font-medium"
              title="Runs in a git worktree"
            >
              wt
            </span>
          ) : segment.key === 'branch' ? (
            <span className="truncate" title={segment.text}>
              ⎇ {segment.text}
            </span>
          ) : (
            <span className={clsx(segment.key === 'dirty' && 'text-warning')}>{segment.text}</span>
          )}
        </span>
      ))}
    </>
  )
}

/**
 * The dot at the head of a session row, in its four states.
 *
 * `data-testid` and `data-state` are asserted by e2e/smoke.spec.ts — the row
 * types must keep emitting the same values.
 */
function SessionIndicator({
  state,
}: {
  state: 'streaming' | 'unseen' | 'live' | 'disk'
}): React.JSX.Element {
  return (
    <span
      data-testid="session-indicator"
      data-state={state}
      className="flex h-4 w-4 shrink-0 items-center justify-center"
    >
      {state === 'streaming' ? (
        <PiSpark size={13} />
      ) : state === 'unseen' ? (
        <span className="bg-success h-2 w-2 rounded-full" title="New activity" />
      ) : state === 'live' ? (
        <span className="border-success h-2 w-2 rounded-full border" title="Live session" />
      ) : (
        <span className="border-border-strong h-2 w-2 rounded-full border" />
      )}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary px-2 pb-0.5 pt-2.5 text-xs font-semibold font-mono uppercase tracking-wider">
      {children}
    </div>
  )
}

/**
 * Flat sidebar nav row, matching the reference: a bordered circular icon
 * badge, then the label at full text weight. No row border or background at
 * rest — the badge is the only chrome, and hover tints the whole row.
 */
function NavRow({
  label,
  icon,
  badge = false,
  active = false,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  /** Draw the icon in a bordered circle (the reference does this for New only). */
  badge?: boolean
  /** This row's page is the one on screen — same fill as an active session row. */
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'text-text group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-left text-lg transition-colors',
        active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
      )}
    >
      <span
        className={clsx(
          'text-text-secondary group-hover:text-text flex h-[22px] w-[22px] shrink-0 items-center justify-center transition-colors',
          badge && 'border-border group-hover:border-border-strong rounded-full border',
        )}
      >
        {icon}
      </span>
      {label}
    </button>
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
