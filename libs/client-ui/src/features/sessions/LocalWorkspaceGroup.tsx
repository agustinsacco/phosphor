import { useMemo } from 'react'
import clsx from 'clsx'
import type { SessionMeta } from '@shared/models'
import { PlusIcon, Spinner } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { sessionTitle } from '@/lib/sessionTitle'
import { localLanePullRequest, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { setGroupCollapsed } from './groupCollapse'
import { useGroupSearch } from './groupSearch'
import { liveByDiskPath, type GroupedSessions } from './groupSessions'
import { LaneGroup, LaneGroupOptions } from './LaneGroup'
import { localLaneGroupKey } from './laneReveal'
import type { LaneSearchFields } from './laneSearch'
import { clearLaneSelection, selectLanes, toggleLane, useGroupSelection } from './laneSelection'
import type { LaneSelectMode } from './LaneSelectionRows'
import { LocalBulkDelete } from './LocalBulkDelete'
import {
  LocalFolderMenuRows,
  localGroupMenuItems,
  startLocalSession,
  type LocalWorktreeModal,
} from './LocalFolderMenuRows'
import { SessionRow } from './LocalLaneRow'
import { confirmSessionDelete, deleteLocalRow } from './localLaneDelete'
import { PendingSessionRow } from './LocalPendingLaneRow'
import { SessionList } from './SessionList'
import { SessionRowSkeletons } from './SidebarPrimitives'
import { isUnseen } from './unseen'
import { useLiveSessionNames } from './useLiveSessionNames'

/**
 * One This Mac workspace group on the shared `LaneGroup`: the folder ⋯ menu,
 * the header's right-click menu, New session here, its pending and scanned
 * rows, its scan state when empty, and its own hold on the lane selection.
 * `collapsed` is the sidebar's, which also decides what is watched.
 */
export function LocalWorkspaceGroup({
  group,
  first,
  last,
  collapsed,
  workspacePath,
  pending,
  onOpenTree,
  onWorktreeModal,
}: {
  group: GroupedSessions
  /** Its place in the sidebar's order, for Move up and Move down. */
  first: boolean
  last: boolean
  collapsed: boolean
  /** The workspace on screen: a row without a cwd belongs to it. */
  workspacePath: string
  /** Live sessions in this group with no session file yet. */
  pending: readonly string[]
  onOpenTree: (meta: SessionMeta) => void
  onWorktreeModal: (modal: LocalWorktreeModal) => void
}): React.JSX.Element {
  const groupKey = localLaneGroupKey(group.workspacePath)
  const git = useSessionsStore((s) => s.gitByCwd[group.workspacePath])
  const search = useGroupSearch()
  const visible = search.filter(group.metas, useLocalLaneFields(search.applied, workspacePath))
  const selection = useGroupSelection(groupKey)
  // Placeholder rows carry no name, branch or PR yet, so a filter can only
  // ever be wrong about them. While one is on, they stand aside.
  const shownPending = search.applied ? [] : pending
  const setCollapsed = (next: boolean): void => {
    if (next === collapsed) return
    setGroupCollapsed(groupKey, next)
    // Expanding catches up on anything missed while the group was unwatched,
    // across every folder merged into this project (main repo + worktrees).
    if (!next) rescan(group)
  }
  return (
    <LaneGroup
      groupKey={groupKey}
      name={group.name}
      tooltip={group.workspacePath}
      liveCount={group.liveCount}
      menu={() => localGroupMenuItems(group, git, onWorktreeModal)}
      collapse={[collapsed, setCollapsed]}
      search={search}
      total={group.metas.length}
      shown={visible.length}
      controls={(className) => (
        <LocalGroupControls
          group={group}
          first={first}
          last={last}
          className={className}
          selection={{
            canSelect: selection.selecting || visible.length > 0,
            selecting: selection.selecting,
            collapsed,
            onCollapse: setCollapsed,
            onSelect: (mode) => selectLocalLanes(selection.key, visible, mode, workspacePath),
          }}
        />
      )}
      rows={
        <LocalGroupRows
          group={group}
          visible={visible}
          pending={shownPending}
          selection={selection}
          filtered={!!search.query}
          workspacePath={workspacePath}
          onOpenTree={onOpenTree}
        />
      }
      empty={pending.length ? null : <LocalGroupScanState group={group} />}
      bulkDelete={<LocalBulkDelete selectionKey={selection.key} workspacePath={workspacePath} />}
    />
  )
}

/** The header's machine controls: the ⋯ menu over this folder's own rows, and New session here. */
function LocalGroupControls({
  group,
  first,
  last,
  className,
  selection,
}: {
  group: GroupedSessions
  first: boolean
  last: boolean
  className: string
  selection: React.ComponentProps<typeof LaneGroupOptions>['selection']
}): React.JSX.Element {
  return (
    <>
      <LaneGroupOptions
        name={group.name}
        className={className}
        selection={selection}
        folderRows={(close) => (
          <LocalFolderMenuRows group={group} first={first} last={last} onDone={close} />
        )}
      />
      <TooltipButton
        onClick={() => startLocalSession(group.workspacePath)}
        data-testid="workspace-group-new-session"
        title="New session here"
        className={clsx(className, 'active:scale-90')}
      >
        <PlusIcon size={12} strokeWidth={2.5} />
      </TooltipButton>
    </>
  )
}

/** The group's pending rows, then its scanned ones, with each box in this group's selection. */
function LocalGroupRows({
  group,
  visible,
  pending,
  selection,
  filtered,
  workspacePath,
  onOpenTree,
}: {
  group: GroupedSessions
  visible: SessionMeta[]
  pending: readonly string[]
  selection: ReturnType<typeof useGroupSelection>
  /** A search is applied: rows cannot be reordered. */
  filtered: boolean
  workspacePath: string
  onOpenTree: (meta: SessionMeta) => void
}): React.JSX.Element {
  const { live, gitByCwd, activeSessionId, rowProps } = useLocalRows(workspacePath, onOpenTree)
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  const visiblePaths = visible.map((meta) => meta.path)
  return (
    <>
      <SessionList
        disabled={filtered || selection.selecting || bulkDeleteRunning}
        items={[
          ...pending.map((phosphorId) => ({
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
                selected={selection.selected.includes(meta.path)}
                selecting={selection.selecting}
                onToggleSelect={(shiftKey) =>
                  toggleLane(selection.key, visiblePaths, meta.path, shiftKey)
                }
              />
            ),
          })),
        ]}
      />
      {/* Rows already scanned stay put while the rest of the group catches
        up: a partial answer must not read as the whole answer, but it must
        not hide what we have either. */}
      {group.metas.length > 0 && group.unscannedPaths.length > 0 && (
        <div className="text-text-tertiary flex items-center gap-1.5 px-2 py-1.5 text-xs">
          <Spinner />
          <span>
            loading {group.unscannedPaths.length} more folder
            {group.unscannedPaths.length === 1 ? '' : 's'}…
          </span>
        </div>
      )}
    </>
  )
}

/** Scan every folder merged into the group: on expand, and on Retry. */
function rescan(group: GroupedSessions): void {
  const store = useSessionsStore.getState()
  for (const path of group.paths) void store.refreshDisk(path)
}

/** The ⋯ menu's lane selection, over the lanes the search shows. */
function selectLocalLanes(
  key: string,
  visible: SessionMeta[],
  mode: LaneSelectMode,
  workspacePath: string,
): void {
  if (mode === 'clear') clearLaneSelection()
  else
    selectLanes(
      key,
      (mode === 'all' ? visible : visible.filter((m) => isMerged(m, workspacePath))).map(
        (meta) => meta.path,
      ),
    )
}

/** A lane whose pull request merged: what "Select merged lanes" picks, as on a Host. */
function isMerged(meta: SessionMeta, workspacePath: string): boolean {
  const git = useSessionsStore.getState().gitByCwd[meta.cwd || workspacePath]
  return localLanePullRequest(usePullRequestsStore.getState(), meta, git)?.state === 'MERGED'
}

/**
 * An empty group's scan state. A failed scan offers Retry across every folder
 * merged into the project, so the sidebar recovers instead of pinning a
 * permanent "Loading sessions…"; an unfinished one shows skeleton rows.
 */
function LocalGroupScanState({ group }: { group: GroupedSessions }): React.JSX.Element {
  if (group.attempted && group.errored)
    return (
      <div className="text-text-tertiary flex items-center gap-2 px-2 py-2 text-sm">
        <span>Couldn&apos;t load sessions</span>
        <TooltipButton
          onClick={() => rescan(group)}
          className="text-text-secondary hover:text-text rounded px-1 underline-offset-2 hover:underline"
        >
          Retry
        </TooltipButton>
      </div>
    )
  if (group.attempted)
    return (
      <div className="text-text-tertiary px-2 py-2 text-sm">
        Sessions you start will show up here
      </div>
    )
  return <SessionRowSkeletons />
}

/**
 * What a This Mac lane is found by: its title (the live name first), its
 * branch, or its pull request. Live names are subscribed only once a search
 * is applied.
 */
function useLocalLaneFields(applied: boolean, workspacePath: string) {
  const prByRepo = usePullRequestsStore((s) => s.byRepo)
  const live = useSessionsStore((s) => s.live)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const liveNames = useLiveSessionNames(applied)
  const byDisk = useMemo(() => liveByDiskPath(live), [live])
  return (meta: SessionMeta): LaneSearchFields => {
    const git = gitByCwd[meta.cwd || workspacePath]
    const livePhosphorId = byDisk.get(meta.path)
    const liveName = livePhosphorId ? liveNames.get(livePhosphorId) : undefined
    return {
      title:
        sessionTitle(
          { explicitName: liveName ?? meta.name, firstUserText: meta.firstUserText },
          { elide: false },
        ) ?? '',
      branch: git?.branch,
      pr: localLanePullRequest({ byRepo: prByRepo }, meta, git),
    }
  }
}

/** Each This Mac row's own state, for the workspace groups and the Pinned list alike. */
export function useLocalRows(workspacePath: string, onOpenTree: (meta: SessionMeta) => void) {
  const live = useSessionsStore((s) => s.live)
  const unread = useSessionsStore((s) => s.unread)
  const seenSessions = useSessionsStore((s) => s.seenSessions)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  /** Session file of the lane being opened right now, if any. */
  const openingPath = useSessionsStore((s) => s.opening?.path)
  const byDisk = useMemo(() => liveByDiskPath(live), [live])
  const rowProps = (meta: SessionMeta) => {
    const livePhosphorId = byDisk.get(meta.path)
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
      onOpenTree: () => onOpenTree(meta),
      onDelete: (title: string) => deleteLocalRow(meta, title, workspacePath),
    }
  }
  return { live, gitByCwd, activeSessionId, rowProps }
}
