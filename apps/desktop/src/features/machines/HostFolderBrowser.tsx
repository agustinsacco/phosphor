import { useEffect, useState } from 'react'
import type { IpcInvokeMap } from '@shared/ipc'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import {
  useRemoteLanesStore,
  machineLabel,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { TooltipButton } from '@/components/Tooltip'

export function HostFolderBrowser({
  hostId,
  onClose,
  onAdded,
}: {
  hostId: string
  onClose: () => void
  onAdded?: (repositoryId: string) => void
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<IpcInvokeMap['hosts:listFolders']['result'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const available = host?.state === 'ready' && host.capabilities.includes('workspaces.write')
  useEffect(() => {
    let alive = true
    setListing(null)
    setError(null)
    if (available)
      void window.phosphor
        .invoke('hosts:listFolders', hostId, path)
        .then((result) => {
          if (alive) setListing(result)
        })
        .catch(() => {
          if (alive) setError(REMOTE_UNAVAILABLE)
        })
    return () => {
      alive = false
    }
  }, [hostId, path, available])
  async function add(): Promise<void> {
    if (!available || !listing || busy) return
    setBusy(true)
    try {
      const added = await window.phosphor.invoke('hosts:addRepository', hostId, listing.path)
      onAdded?.(added.repositoryId)
      onClose()
    } catch {
      setError('The Host could not add this folder. Check its configuration before retrying.')
    } finally {
      setBusy(false)
    }
  }
  const parts = path.split('/').filter(Boolean)
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <ModalPanel
        title={`Add folder on ${machineLabel(hostId)}`}
        subtitle="Choose a folder under this machine's home directory."
        width={480}
      >
        <div className="space-y-3 p-4">
          <nav
            aria-label="Folder breadcrumbs"
            className="flex flex-wrap items-center gap-1 text-sm"
          >
            <Button size="sm" disabled={busy} onClick={() => setPath('')}>
              Home
            </Button>
            {parts.map((part, index) => (
              <Button
                key={index}
                size="sm"
                disabled={busy}
                onClick={() => setPath(parts.slice(0, index + 1).join('/'))}
              >
                {part}
              </Button>
            ))}
          </nav>
          {!available ? (
            <p role="alert">{host?.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}</p>
          ) : (
            <div className="border-border max-h-72 min-h-40 overflow-y-auto rounded-md border">
              {!listing ? (
                <p className="text-text-tertiary p-3">Loading folders…</p>
              ) : (
                listing.entries.map((entry) => (
                  <TooltipButton
                    key={entry.name}
                    tooltip={false}
                    type="button"
                    disabled={busy}
                    className="hover:bg-bg-secondary flex w-full items-center gap-2 px-3 py-2 text-left text-lg"
                    onClick={() => setPath([path, entry.name].filter(Boolean).join('/'))}
                  >
                    <span aria-hidden>▸</span>
                    <span className="flex-1 truncate">{entry.name}</span>
                    {entry.isRepository && (
                      <span className="text-text-tertiary bg-chip rounded px-1 text-xs">git</span>
                    )}
                    {entry.configured && <span className="text-text-tertiary text-xs">Added</span>}
                  </TooltipButton>
                ))
              )}
              {listing?.entries.length === 0 && (
                <p className="text-text-tertiary p-3">No subfolders</p>
              )}
            </div>
          )}
          {listing?.truncated && (
            <p className="text-text-tertiary text-sm">Showing the first 500 folders.</p>
          )}
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!available || !listing || busy}
              onClick={() => void add()}
            >
              {busy ? 'Adding…' : 'Add this folder'}
            </Button>
          </div>
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
