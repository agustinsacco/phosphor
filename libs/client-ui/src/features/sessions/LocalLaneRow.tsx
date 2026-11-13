import { useState } from 'react'
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
import { committedRename } from './inlineRename'
import { LaneMarker } from './LaneMarker'
import { SelectableIndicator } from './LaneSelect'
import { useNameTransition } from './nameTransition'
import { PrBadge } from './PrBadge'
import { sessionSubtitle } from './sessionSubtitle'
import { renameSidebarSession } from './sidebarActions'
import { LaneRow, SubtitleSegments } from './SidebarPrimitives'
import { useLocalLaneActions } from './useLocalLaneActions'
import { useLocalLanePrs } from './useLanePrs'

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
export const SESSION_TITLE_CLASS = 'text-text block truncate text-lg font-medium leading-5'

function localRowClass(active: boolean, selected: boolean, deleting: boolean): string {
  return clsx(
    'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-[color,background-color,opacity]',
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
  const pullRequest = prs.owned[0]?.pr
  const showPrStatus = useLanePrefsStore((s) => s.lanes.prStatus)
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
    pullRequest,
    deleting,
    onRename: beginRename,
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

  const body = (
    <>
      <SelectableIndicator
        state={indicatorState}
        select={
          onToggleSelect && !deleting
            ? { title, selected, selecting, onToggle: onToggleSelect }
            : undefined
        }
      />
      {markerMode !== 'off' && (
        <LaneMarker marker={marker} onPick={deleting ? undefined : actions.pickMarker} />
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
          {showPrStatus && pullRequest && <PrBadge pr={pullRequest} more={prs.owned.length - 1} />}
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

/**
 * The inline rename field, shared by both row types.
 *
 * Shared rather than duplicated for the same reason the subtitle is: a live
 * session swaps from `PendingSessionRow` to `SessionRow` mid-turn, and the
 * editor must not change shape under the caret when it does.
 */
export function RenameInput({
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
