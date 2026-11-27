import { useBrain } from '@/features/brain/useBrain'
import clsx from 'clsx'
import type { GitInfo, SessionMeta } from '@shared/models'
import { useMenuTriggers } from '@/components/ContextMenu'
import { PinIcon } from '@/components/icons'
import { useSessionBooting } from '@/features/chat/BootingIndicator'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from '@/features/chat/subagentRuns'
import { laneMarker } from '@/lib/laneMarker'
import { projectName } from '@/lib/path'
import { sessionTitle } from '@/lib/sessionTitle'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { laneIsBeingDeleted, useSessionsStore } from '@/stores/sessions'
import { openSidebarConversation } from './completionActions'
import { laneRowBody, localLaneTitle, useInlineRename } from './laneRowBody'
import { LaneMarker } from './LaneMarker'
import { SelectableIndicator } from './LaneSelect'
import { useNameTransition } from './nameTransition'
import { PrBadge } from './PrBadge'
import { sessionSubtitle } from './sessionSubtitle'
import { renameSidebarSession } from './sidebarActions'
import { LANE_ROW_CLASS, LaneRow, SubtitleSegments } from './SidebarPrimitives'
import { useLocalLaneActions } from './useLocalLaneActions'
import { useLocalLanePrs } from './useLanePrs'

function localRowClass(active: boolean, selected: boolean, deleting: boolean): string {
  return clsx(
    LANE_ROW_CLASS,
    // Selection stays neutral; working has its own rail and activity label.
    active ? 'bg-sidebar-active' : !deleting && 'hover:bg-sidebar-hover',
    selected && 'bg-accent-soft',
    deleting && 'cursor-wait opacity-45',
  )
}

export function SessionRow({
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
  // Derived here rather than threaded through `rowProps` so a Pinned row — which
  // may belong to a different project than the one on screen — resolves its own.
  const prs = useLocalLanePrs(meta, git)
  const showPrStatus = useLanePrefsStore((s) => s.lanes.prStatus)
  const explicitMarker = useSessionsStore((s) => s.laneMarkers[meta.path])
  const markerMode = useLanePrefsStore((s) => s.lanes.markers)
  // Keyed on the branch, not the title: Phosphor names a session only after its
  // first turn ends, so a title-derived marker would change under the user the
  // moment the auto-namer landed.
  const brainFolder = useBrain((s) => s.status?.agent.folder)
  const marker = laneMarker(explicitMarker, git?.branch, meta.cwd, markerMode, brainFolder)
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

  const rename = useInlineRename(title, (name) => {
    void renameSidebarSession(workspacePath, meta, name, livePhosphorId)
  })
  const renaming = rename.editing
  // Badge reads the session's own cwd, so a Pinned row shows the project it
  // actually belongs to rather than whatever is on screen. Project only — the
  // subtitle beneath it already carries `wt` and the branch.
  const rowWorkspaceName = projectName(meta.cwd || workspacePath, git)

  const open = (): void => openSidebarConversation(workspacePath, meta)
  const activity =
    isStreaming || delegated ? 'working' : opening ? 'opening' : booting ? 'starting' : undefined
  const actions = useLocalLaneActions({
    meta,
    workspacePath,
    livePhosphorId,
    working: activity !== undefined,
    title,
    unseen,
    pinned: isPinned,
    git,
    prs: prs.owned,
    deleting,
    onRename: rename.begin,
    onOpenTree,
    onDelete,
  })
  const menu = useMenuTriggers(actions.items, { title })

  const subtitle = sessionSubtitle(meta, git)
  const indicatorState = activity
    ? 'streaming'
    : unseen
      ? 'unseen'
      : livePhosphorId
        ? 'live'
        : 'disk'

  const rowClassName = localRowClass(active, selected, deleting)

  const body = laneRowBody({
    indicator: (
      <SelectableIndicator
        state={indicatorState}
        select={
          onToggleSelect && !deleting
            ? { title, selected, selecting, onToggle: onToggleSelect }
            : undefined
        }
      />
    ),
    marker: markerMode !== 'off' && (
      <LaneMarker marker={marker} onPick={deleting ? undefined : actions.pickMarker} />
    ),
    title: rename.editor ?? localLaneTitle(title, naming),
    subtitleClassName: clsx(
      '@container/lane-line flex items-center gap-1 text-base leading-4',
      active ? 'text-text' : 'text-text-secondary',
    ),
    subtitle: (
      <>
        {isSuspended && (
          <span
            className="bg-chip text-text-secondary mr-0.5 shrink-0 rounded px-1 font-medium"
            data-tooltip="Suspended to save memory · opening resumes it"
          >
            suspended
          </span>
        )}
        <SubtitleSegments segments={subtitle} activity={activity} />
        {showPrStatus && <PrBadge prs={prs.owned} />}
      </>
    ),
    trailing: (
      <>
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
    ),
  })

  // The rename input needs a div. The inspector and portalled marker picker
  // stay siblings of the navigation button, never nested interactive controls.
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {renaming ? (
          <div
            data-testid="session-row"
            data-workspace={rowWorkspaceName}
            data-activity={activity}
            data-deleting={deleting || undefined}
            aria-disabled={deleting}
            className={clsx(rowClassName, 'min-w-0 flex-1')}
          >
            {body}
          </div>
        ) : (
          <LaneRow
            onClick={open}
            {...menu}
            onDoubleClick={rename.begin}
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
            className={clsx(rowClassName, 'min-w-0 flex-1')}
          >
            {body}
          </LaneRow>
        )}
      </div>
      {actions.dialogs}
    </>
  )
}
