import { PurgeConfirm } from './PurgeConfirm'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'

/** The single-entry sibling of `BulkPurgeModal`; the two share `PurgeConfirm`. */
export function PurgeArchiveModal({
  entry,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  entry: LaneArchiveEntry
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (removeWorktree: boolean) => void
}): React.JSX.Element {
  // Only a lane that got its own worktree has one to lose.
  const worktree = entry.worktree
    ? {
        label: 'Also remove this dedicated worktree',
        note: (
          <>
            Permanently deletes all uncommitted, untracked and ignored files. Refused if another
            lane uses it.
            <span className="text-text-secondary mt-1 block break-all">{entry.cwd}</span>
          </>
        ),
      }
    : undefined
  return (
    <PurgeConfirm
      title={`Clean up “${entry.title}”?`}
      subtitle="Remove this archived conversation and its lane-owned files from Phosphor. This cannot be undone from Archive. Shared project folders and branches are kept."
      confirmLabel="Permanently clean up"
      acknowledgement={entry.cwd}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={onConfirm}
      worktree={worktree}
    />
  )
}
