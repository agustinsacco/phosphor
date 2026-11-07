import { lazy, Suspense, useMemo, useState } from 'react'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { formatCost } from '@/lib/format'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { makeRoutine } from '@/stores/routines'
import { navigateToLane } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { GhPullRequest, GitInfo, SessionMeta } from '@shared/models'
import { changeCompletion, openRestoreWorktree, openSidebarConversation } from './completionActions'
import { laneActions, type LaneActionContext, type LaneActions } from './laneActions'
import { openPullRequest } from './PrBadge'
import { copySessionDebugInfo, copySpend, exportSessionHtml } from './sessionActions'
import { useSessionOrderActions } from './SessionList'
import { cloneSession, exportSidebarSession } from './sidebarActions'

// Keep the full emoji catalog out of startup and marker-disabled sessions.
const MarkerPickerModal = lazy(() =>
  import('./MarkerPickerModal').then((module) => ({ default: module.MarkerPickerModal })),
)

/** A This Mac sidebar row's lane, and the actions its row keeps. */
interface LocalLane {
  meta: SessionMeta
  workspacePath: string
  livePhosphorId?: string
  title: string
  unseen: boolean
  pinned: boolean
  git?: GitInfo
  pullRequest: GhPullRequest | undefined
  deleting: boolean
  onRename: () => void
  onOpenTree: () => void
  onDelete: (title: string) => void
}

/**
 * A This Mac lane's actions and the marker picker they open, for its sidebar
 * row: the shared `laneActions` list over This Mac's handlers. The row owns
 * how a rename is asked for (inline), the tree and the delete confirm.
 */
export function useLocalLaneActions({
  meta,
  workspacePath,
  livePhosphorId,
  title,
  unseen,
  pinned,
  git,
  pullRequest,
  deleting,
  onRename,
  onOpenTree,
  onDelete,
}: LocalLane): LaneActions {
  const orderActions = useSessionOrderActions()
  const markers = useLanePrefsStore((s) => s.lanes.markers)
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  const [pickingMarker, setPickingMarker] = useState(false)
  const context: LaneActionContext = {
    pinned,
    markers,
    pr: pullRequest ?? null,
    unseen,
    running: livePhosphorId !== undefined,
    completed: Boolean(meta.completedAt),
    worktreeRemoved: meta.worktreeRemoved,
    // Spend is a detail you go looking for, so it waits here (and in the Home ledger).
    spend: meta.cost > 0 ? { hint: formatCost(meta.cost) } : undefined,
    busy: deleting,
    refusals: { delete: bulkDeleteRunning ? 'another delete is running' : undefined },
    // Stop ends the process and keeps the transcript, as on a Host lane.
    hints: { stop: '~200 MB', delete: 'to trash' },
  }
  const store = () => useSessionsStore.getState()
  const items = (): ContextMenuItem[] =>
    laneActions(
      context,
      {
        open: () => openSidebarConversation(workspacePath, meta),
        rename: onRename,
        tree: onOpenTree,
        completion: () => void changeCompletion(workspacePath, meta),
        restoreWorktree: () => openRestoreWorktree(workspacePath, meta),
        makeRoutine: () => makeRoutine(workspacePath, meta.name ?? '', meta.firstUserText ?? ''),
        pin: () => store().togglePin(meta.path),
        marker: () => setPickingMarker(true),
        // Keyboard route for the PR chip (see PrBadge).
        openPullRequest: () => {
          if (pullRequest) void openPullRequest(pullRequest)
        },
        stop: () => {
          if (livePhosphorId) void store().suspendSession(livePhosphorId)
        },
        markRead: () => store().markRead(meta.path, livePhosphorId),
        fork: () => void store().createSession(workspacePath, { forkFrom: meta.path }),
        clone: () => void cloneSession(workspacePath, meta, livePhosphorId),
        exportHtml: () => void exportSidebarSession(workspacePath, meta, livePhosphorId),
        copyDebugInfo: () => void copySessionDebugInfo(meta, livePhosphorId),
        copySpend: () => void copySpend(meta.cost),
        delete: () => onDelete(title),
      },
      orderActions,
    )
  const dialogs = pickingMarker && markers !== 'off' && (
    <LocalMarkerPicker
      mode={markers}
      meta={meta}
      title={title}
      git={git}
      onClose={() => setPickingMarker(false)}
    />
  )
  return { items, dialogs, pickMarker: () => setPickingMarker(true) }
}

/**
 * A pending lane's actions, before its session file lands: no path yet, so
 * only Open, Rename…, Export HTML… and Delete.
 */
export function usePendingLaneActions({
  phosphorId,
  title,
  deleting,
  onRename,
  onDelete,
}: {
  phosphorId: string
  title: string
  deleting: boolean
  onRename: () => void
  onDelete: (title: string) => void
}): () => ContextMenuItem[] {
  const orderActions = useSessionOrderActions()
  // No marker handler: the preference does not reach this menu.
  const context: LaneActionContext = {
    pinned: false,
    markers: 'auto',
    pr: null,
    unseen: false,
    // A pending lane is a live process with no file yet. It gets no stop or resume
    // handler, so neither item shows whatever `running` says.
    running: true,
    busy: deleting,
    refusals: {},
  }
  return () =>
    laneActions(
      context,
      {
        open: () => void navigateToLane({ sessionId: phosphorId }),
        rename: onRename,
        exportHtml: () => void exportSessionHtml(phosphorId, title),
        delete: () => onDelete(title),
      },
      orderActions,
    )
}

/** The lane marker picker, dimming the markers other lanes on This Mac chose. */
function LocalMarkerPicker({
  mode,
  meta,
  title,
  git,
  onClose,
}: {
  mode: 'auto' | 'manual'
  meta: SessionMeta
  title: string
  git?: GitInfo
  onClose: () => void
}): React.JSX.Element {
  const explicitMarker = useSessionsStore((s) => s.laneMarkers[meta.path])
  /**
   * Markers already spoken for on this machine, in any workspace, so the
   * picker can dim them (a Host's picker dims its own lanes' alike).
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
  return (
    <Suspense fallback={null}>
      <MarkerPickerModal
        title={title}
        current={explicitMarker}
        autoKey={git?.branch || meta.cwd}
        mode={mode}
        usedMarkers={takenMarkers}
        onPick={(next) => {
          useSessionsStore.getState().setLaneMarker(meta.path, next)
          onClose()
        }}
        onClose={onClose}
      />
    </Suspense>
  )
}
