import { useBrain } from '@/features/brain/useBrain'
import clsx from 'clsx'
import type { GitInfo } from '@shared/models'
import { useMenuTriggers } from '@/components/ContextMenu'
import { TooltipButton } from '@/components/Tooltip'
import { useSessionBooting } from '@/features/chat/BootingIndicator'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from '@/features/chat/subagentRuns'
import { laneMarker } from '@/lib/laneMarker'
import { sessionTitle } from '@/lib/sessionTitle'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { navigateToLane } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { LaneMarker } from './LaneMarker'
import { laneRowBody, localLaneTitle, useInlineRename } from './laneRowBody'
import { useNameTransition } from './nameTransition'
import { applySessionRename } from './sessionActions'
import { sessionSubtitle } from './sessionSubtitle'
import { SessionIndicator, SubtitleSegments } from './SidebarPrimitives'
import { usePendingLaneActions } from './useLocalLaneActions'

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
export function PendingSessionRow({
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
  const { marker, markerMode } = usePendingMarker(phosphorId, git?.branch)

  // No `refreshDisk` follow-up, unlike the disk-backed row: there is no file
  // to rescan yet. `applySessionRename` patches the chat store, and this row's
  // title reads that store, so the new name shows immediately and survives the
  // swap to `SessionRow` (which prefers the live name too).
  const rename = useInlineRename(title, (name) => void applySessionRename(phosphorId, name))
  const renaming = rename.editing
  const menuItems = usePendingLaneActions({
    phosphorId,
    title,
    deleting,
    onRename: rename.begin,
    onDelete,
  })
  const menu = useMenuTriggers(menuItems, { title })

  const className = clsx(
    'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
    // Same treatment as SessionRow — see the comment there. It must match
    // exactly: this row is replaced by a real SessionRow the moment the
    // session file lands, and any difference reads as the row twitching.
    active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
  )

  const body = laneRowBody({
    indicator: <SessionIndicator state={activity ? 'streaming' : 'live'} />,
    marker: markerMode !== 'off' && <LaneMarker marker={marker} />,
    title: rename.editor ?? localLaneTitle(title, naming),
    subtitleClassName: clsx(
      'flex items-center gap-1 text-base leading-4',
      active ? 'text-text' : 'text-text-secondary',
    ),
    subtitle: <SubtitleSegments segments={subtitle} activity={activity} />,
  })

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
      onDoubleClick={rename.begin}
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

/** Pending and persisted rows must derive the same marker before the file arrives. */
function usePendingMarker(id: string, branch: string | undefined) {
  const markerMode = useLanePrefsStore((s) => s.lanes.markers)
  const brainFolder = useBrain((s) => s.status?.agent.folder)
  const cwd = useSessionsStore((s) => s.live[id]?.workspacePath)
  return { markerMode, marker: laneMarker(undefined, branch, cwd, markerMode, brainFolder) }
}
