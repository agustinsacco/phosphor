import { useState } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { TooltipButton } from '@/components/Tooltip'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'

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
  const [removeWorktree, setRemoveWorktree] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="bg-surface-raised border-border w-[min(34rem,94vw)] space-y-4 rounded-lg border p-5 shadow-2xl">
        <h2 className="font-semibold">Permanently clean up “{entry.title}”?</h2>
        <p className="text-text-secondary text-sm">
          Remove this archived conversation and its lane-owned files from Phosphor. This cannot be
          undone from Archive. Shared project folders and branches are kept.
        </p>
        {entry.worktree && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeWorktree}
              disabled={busy}
              onChange={(event) => {
                setRemoveWorktree(event.target.checked)
                setAcknowledged(false)
              }}
            />
            <span>
              Also permanently remove this dedicated worktree, including all uncommitted, untracked
              and ignored files. Refused if another lane uses it.
              <span className="mt-1 block break-all text-xs">{entry.cwd}</span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand that cleanup is permanent.
        </label>
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <TooltipButton disabled={busy} onClick={onClose}>
            Cancel
          </TooltipButton>
          <TooltipButton
            disabled={busy || !acknowledged}
            className="bg-danger rounded px-3 py-1 text-white"
            onClick={() => onConfirm(removeWorktree)}
          >
            {busy ? 'Cleaning up…' : 'Permanently clean up'}
          </TooltipButton>
        </div>
      </div>
    </ModalOverlay>
  )
}
