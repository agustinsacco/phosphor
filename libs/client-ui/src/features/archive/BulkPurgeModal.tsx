import { PurgeConfirm } from './PurgeConfirm'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'

/**
 * Confirm for cleaning up several archives at once.
 *
 * The list is shown in full because a bulk cleanup is the one place you cannot
 * read the entries off the screen behind the dialog.
 */
export function BulkPurgeModal({
  entries,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  entries: readonly LaneArchiveEntry[]
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (removeWorktree: boolean) => void
}): React.JSX.Element {
  const plural = entries.length === 1 ? 'lane' : 'lanes'
  const worktrees = entries.filter((entry) => entry.worktree === true).length
  const worktree = worktrees
    ? {
        label: `Also remove their dedicated worktrees (${worktrees})`,
        note:
          'Permanently deletes each worktree under `.phosphor/worktrees/`, uncommitted, ' +
          'untracked and ignored files included. Refused for any folder another lane still ' +
          'uses. Shared folders and branches are never removed.',
      }
    : undefined
  return (
    <PurgeConfirm
      title={`Clean up ${entries.length} archived ${plural}`}
      subtitle="Remove these archived conversations and their lane-owned files from Phosphor. This cannot be undone from Archive. Shared project folders and branches are kept."
      confirmLabel={`Clean up ${entries.length} archived ${plural}`}
      acknowledgement={`${entries.length} archived ${plural} on this machine.`}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={onConfirm}
      worktree={worktree}
    >
      <div className="max-h-56 overflow-y-auto px-4 py-3">
        <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {entry.worktree === true && (
                <span className="text-text-tertiary shrink-0 text-xs">dedicated worktree</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </PurgeConfirm>
  )
}
