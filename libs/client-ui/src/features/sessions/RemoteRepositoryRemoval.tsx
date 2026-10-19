import { useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

/** Mirrors the main process's last-repository refusal (electron/hosts/repository-management.ts). */
export const LAST_FOLDER_REFUSAL = 'A machine needs at least one folder. Add another first.'

export function RemoteRepositoryRemoval({
  hostId,
  repositoryId,
  name,
  onClose,
}: {
  hostId: string
  repositoryId: string
  name: string
  onClose: () => void
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allowed = host?.state === 'ready' && host.capabilities.includes('workspaces.write')
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <ModalPanel title={`Remove from ${machineLabel(hostId)}?`} width={420}>
        <div className="space-y-4 p-4">
          <p>{name}: files are kept. A repository with a live lane cannot be removed.</p>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy || !allowed}
              onClick={() => {
                setBusy(true)
                void window.phosphor
                  .invoke('hosts:removeRepository', hostId, repositoryId)
                  .then(onClose)
                  .catch((error: unknown) =>
                    setError(
                      // Only the fixed last-folder refusal is safe to show verbatim.
                      error instanceof Error && error.message.includes(LAST_FOLDER_REFUSAL)
                        ? LAST_FOLDER_REFUSAL
                        : 'The Host could not remove this folder. Stop its lanes before retrying.',
                    ),
                  )
                  .finally(() => setBusy(false))
              }}
            >
              Remove folder
            </Button>
          </div>
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
