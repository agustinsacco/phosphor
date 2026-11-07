import { useEffect } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { BulkDeleteModal } from './BulkDeleteModal'
import { DeleteSessionModal } from './DeleteSessionModal'
import { LaneBulkBar } from './LaneSelect'
import { clearLaneSelection, useSelectedKeys, useSelectionOwner } from './laneSelection'
import {
  buildLaneDelete,
  confirmLaneDelete,
  confirmSessionDelete,
  useLocalLaneDelete,
} from './localLaneDelete'

/**
 * A This Mac group's bulk delete bar over the lanes selected in its rows, the
 * mirror of `RemoteBulkDelete`. Selection itself is `laneSelection.ts`. Only
 * in select mode, so it costs no pixels the rest of the time; it sits over
 * the sidebar rather than adding a permanent toolbar row.
 */
export function LocalBulkDelete({
  selectionKey,
  workspacePath,
}: {
  /** This group's key in `laneSelection.ts`: its workspace path. */
  selectionKey: string
  workspacePath: string
}): React.JSX.Element | null {
  const confirming = useLocalLaneDelete((s) => s.lanes !== null)
  const owner = useSelectionOwner([selectionKey], confirming)
  const keys = useSelectedKeys(owner)
  const running = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  if (owner === null) return null
  return (
    <LaneBulkBar
      count={keys.length}
      running={running}
      className="absolute inset-x-2 bottom-2"
      onDelete={() => {
        if (keys.length) confirmLaneDelete(buildLaneDelete([...keys], workspacePath))
      }}
      onCancel={clearLaneSelection}
    />
  )
}

/** This Mac's delete confirms, whichever row, pending row or group bar opened them. */
export function LocalDeleteDialogs({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const { lanes, session } = useLocalLaneDelete()
  // The confirms live as long as the sidebar that opened them.
  useEffect(() => () => useLocalLaneDelete.setState({ lanes: null, session: null }), [])
  return (
    <>
      {session && (
        <DeleteSessionModal target={session} onClose={() => confirmSessionDelete(null)} />
      )}
      {lanes && (
        <BulkDeleteModal
          summary={lanes}
          onCancel={() => confirmLaneDelete(null)}
          onConfirm={(options) => {
            const chosen = lanes.deletable.map((lane) => ({
              path: lane.path,
              title: lane.title,
              worktreePath: lane.worktreePath,
              mainRepoPath: lane.mainRepoPath,
            }))
            // Progress owns its own lane snapshot, so select mode can end as
            // soon as the non-blocking notification takes over.
            confirmLaneDelete(null)
            clearLaneSelection()
            void useSessionsStore.getState().deleteManySessions(workspacePath, chosen, options)
          }}
        />
      )}
    </>
  )
}
