import { useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, CheckRow } from '@/components/form'

/**
 * The permanent step, with one home.
 *
 * Both cleanup confirmations say the same thing: this is irreversible, the
 * checkout survives unless you ask otherwise, and the acknowledgement has to be
 * renewed whenever that choice changes. So the choice and the acknowledgement
 * live here, and each caller only supplies the words and, for a bulk cleanup,
 * the list of what is about to go.
 */
export function PurgeConfirm({
  title,
  subtitle,
  confirmLabel,
  worktree,
  acknowledgement,
  busy,
  error,
  onClose,
  onConfirm,
  children,
}: {
  title: string
  subtitle: string
  confirmLabel: string
  /** Omit when nothing selected has a dedicated worktree to lose. */
  worktree?: { label: string; note: React.ReactNode }
  acknowledgement: React.ReactNode
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (removeWorktree: boolean) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const [removeWorktree, setRemoveWorktree] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <ModalPanel
        width={560}
        title={title}
        subtitle={subtitle}
        footer={
          <PurgeFooter
            busy={busy}
            acknowledged={acknowledged}
            confirmLabel={confirmLabel}
            onClose={onClose}
            onConfirm={() => onConfirm(removeWorktree)}
          />
        }
      >
        {children}
        <PurgeOptions
          worktree={worktree}
          acknowledgement={acknowledgement}
          removeWorktree={removeWorktree}
          acknowledged={acknowledged}
          busy={busy}
          error={error}
          onWorktree={(next) => {
            setRemoveWorktree(next)
            setAcknowledged(false)
          }}
          onAcknowledge={setAcknowledged}
        />
      </ModalPanel>
    </ModalOverlay>
  )
}

function PurgeOptions({
  worktree,
  acknowledgement,
  removeWorktree,
  acknowledged,
  busy,
  error,
  onWorktree,
  onAcknowledge,
}: {
  worktree?: { label: string; note: React.ReactNode }
  acknowledgement: React.ReactNode
  removeWorktree: boolean
  acknowledged: boolean
  busy: boolean
  error: string | null
  onWorktree: (next: boolean) => void
  onAcknowledge: (next: boolean) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1 px-4 pb-4">
      {worktree && (
        <CheckRow
          checked={removeWorktree}
          disabled={busy}
          label={worktree.label}
          onChange={onWorktree}
        >
          {worktree.note}
        </CheckRow>
      )}
      <div className="border-danger bg-danger-soft mt-2 rounded-md border px-3 py-2">
        <CheckRow
          checked={acknowledged}
          disabled={busy}
          label="I understand this is permanent."
          onChange={onAcknowledge}
        >
          {acknowledgement}
        </CheckRow>
      </div>
      {error && (
        <p role="alert" className="text-danger pt-1 text-sm">
          {error}
        </p>
      )}
    </div>
  )
}

function PurgeFooter({
  busy,
  acknowledged,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  busy: boolean
  acknowledged: boolean
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <>
      <Button disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button variant="danger" disabled={busy || !acknowledged} onClick={onConfirm}>
        {busy ? 'Cleaning up…' : confirmLabel}
      </Button>
    </>
  )
}
