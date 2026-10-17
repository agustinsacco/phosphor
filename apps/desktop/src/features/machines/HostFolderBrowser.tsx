import { useEffect, useState } from 'react'
import type { IpcInvokeMap } from '@shared/ipc'
import { ModalOverlay, ModalPanel, useEscapeKey } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { FOLDER_EXISTS, HOST_TOO_OLD, isFolderName } from '@shared/host-protocol-repositories'
import {
  useRemoteLanesStore,
  machineLabel,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { TooltipButton, TooltipLabel } from '@/components/Tooltip'

/** Inline name entry; its own Escape cancels the name, not the whole dialog. */
function NewFolderRow({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean
  onCreate: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  useEscapeKey(onCancel, !busy)
  const valid = isFolderName(name.trim())
  return (
    <form
      className="flex items-center gap-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !busy) onCreate(name.trim())
      }}
    >
      <TextInput
        autoFocus
        size="sm"
        className="flex-1"
        aria-label="New folder name"
        placeholder="Folder name"
        maxLength={255}
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={!valid || busy}>
        Create
      </Button>
    </form>
  )
}

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
  const [hidden, setHidden] = useState(false)
  const [naming, setNaming] = useState(false)
  const available = host?.state === 'ready' && host.capabilities.includes('workspaces.write')
  const canCreate = available && host.capabilities.includes('sessions.control')
  useEffect(() => {
    let alive = true
    setListing(null)
    setError(null)
    setNaming(false)
    if (available)
      void window.phosphor
        .invoke('hosts:listFolders', hostId, path, hidden)
        .then((result) => {
          if (alive) setListing(result)
        })
        .catch(() => {
          // Only a Host that predates hidden listings refuses this where a plain one works.
          if (alive)
            setError(
              hidden ? `Hidden folders need a newer Host. ${HOST_TOO_OLD}` : REMOTE_UNAVAILABLE,
            )
        })
    return () => {
      alive = false
    }
  }, [hostId, path, hidden, available])
  async function create(name: string): Promise<void> {
    if (!canCreate || !listing || busy) return
    const created = [listing.path, name].filter(Boolean).join('/')
    setBusy(true)
    setError(null)
    try {
      await window.phosphor.invoke('hosts:createFolder', hostId, created)
      setPath(created)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setError(
        [FOLDER_EXISTS, HOST_TOO_OLD].find((fixed) => message.includes(fixed)) ??
          'The Host could not create this folder.',
      )
    } finally {
      setBusy(false)
    }
  }
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
          <div className="flex items-center justify-between gap-2">
            <TooltipLabel className="flex shrink-0 cursor-pointer items-center gap-1.5 py-1 text-sm">
              <input
                type="checkbox"
                checked={hidden}
                disabled={busy || !available}
                onChange={(e) => setHidden(e.target.checked)}
                className="accent-accent"
              />
              Show hidden
            </TooltipLabel>
            <Button
              size="sm"
              disabled={busy || naming || !canCreate || !listing}
              onClick={() => setNaming(true)}
            >
              New folder
            </Button>
          </div>
          {!available ? (
            <p role="alert">{host?.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}</p>
          ) : (
            <div className="border-border max-h-72 min-h-40 overflow-y-auto rounded-md border">
              {naming && (
                <NewFolderRow
                  busy={busy}
                  onCreate={(name) => void create(name)}
                  onCancel={() => setNaming(false)}
                />
              )}
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
              {listing?.entries.length === 0 && !naming && (
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
