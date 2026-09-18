import { useState } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { useSessionsStore } from '@/stores/sessions'
import { errorText } from '@shared/errors'

export interface DeleteSessionTarget {
  title: string
  workspacePath: string
  path?: string
  sessionId?: string
}

/** Same confirmation for saved, starting, crashed and orphaned sessions. */
export function DeleteSessionModal({
  target,
  onClose,
}: {
  target: DeleteSessionTarget
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await useSessionsStore.getState().deleteSession(target.workspacePath, target)
      onClose()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="bg-surface-raised border-border w-[min(28rem,94vw)] space-y-4 rounded-lg border p-5 shadow-2xl">
        <h2 className="text-base font-semibold">Delete session?</h2>
        <p className="break-words font-medium">{target.title}</p>
        <p className="text-text-secondary text-sm">
          Any running turn will be stopped. Saved transcripts go to Trash; unsaved conversation is
          discarded. The worktree, branch and project files are kept.
        </p>
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={onClose}
            className="border-border rounded-md border px-3 py-1 text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={() => void remove()}
            className="bg-danger rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete session'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
