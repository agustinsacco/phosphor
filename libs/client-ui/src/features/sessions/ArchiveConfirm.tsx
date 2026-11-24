import { ServiceLaneControlRefused } from '@/platform/serviceLaneControl'
import { useState } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { TooltipButton } from '@/components/Tooltip'
import { useSessionsStore } from '@/stores/sessions'
import type { DeleteSessionTarget } from './DeleteSessionModal'

export function ArchiveConfirm({
  titles,
  onCancel,
  onConfirm,
  busy = false,
  error,
}: {
  titles: string[]
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
  error?: string | null
}): React.JSX.Element {
  const label = titles.length === 1 ? 'Archive lane' : `Archive ${titles.length} lanes`
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onCancel()
      }}
    >
      <div className="bg-surface-raised border-border w-[min(32rem,94vw)] space-y-4 rounded-lg border p-5 shadow-2xl">
        <h2 className="font-semibold">{label}</h2>
        <p className="text-text-secondary text-sm">
          Stop these lanes and hide them from the sidebar. Conversations and the entire worktree,
          including uncommitted, untracked and ignored files, stay on this machine until you
          explicitly clean them up.
        </p>
        <ul className="max-h-48 overflow-auto text-sm">
          {titles.map((title, i) => (
            <li key={i} className="truncate">
              {title}
            </li>
          ))}
        </ul>
        <p className="text-text-secondary text-sm">
          Restore them from Archive. Nothing expires automatically.
        </p>
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <TooltipButton disabled={busy} onClick={onCancel}>
            Cancel
          </TooltipButton>
          <TooltipButton
            disabled={busy || titles.length === 0}
            onClick={onConfirm}
            className="bg-accent rounded px-3 py-1 text-white"
          >
            {busy ? 'Archiving…' : label}
          </TooltipButton>
        </div>
      </div>
    </ModalOverlay>
  )
}

export function ArchiveSessionModal({
  target,
  onClose,
  onArchive,
}: {
  target: DeleteSessionTarget
  onClose: () => void
  onArchive?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (onArchive) await onArchive()
      else
        await useSessionsStore
          .getState()
          .deleteSession(target.workspacePath, { ...target, archive: true })
      onClose()
    } catch (error) {
      setError(
        error instanceof ServiceLaneControlRefused
          ? error.message
          : onArchive
            ? 'The Host could not archive this lane. Send or remove unsent file attachments, then check Archive before retrying.'
            : error instanceof Error
              ? error.message
              : 'Archive failed. Check Archive for unfinished work before retrying.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <ArchiveConfirm
      titles={[target.title]}
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={() => {
        void run()
      }}
    />
  )
}
