import { TooltipButton } from '@/components/Tooltip'
import { useState } from 'react'
import { isLaneBranchName } from '@shared/host-protocol'
import { ModalOverlay } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import {
  adoptRemoteLane,
  canReadHost,
  machineLabel,
  openRemoteLane,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'

export function RemoteLanes(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const filter = useRemoteLanesStore((s) => s.filter)
  const error = useRemoteLanesStore((s) => s.error)
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  useMachinesStore((s) => s.machines)
  const [creating, setCreating] = useState<string | null>(null)
  const readable = Object.entries(hosts).filter(([, host]) => canReadHost(host))
  if (!readable.length) return null
  return (
    <div className="space-y-2 px-2 pb-2">
      <select
        aria-label="Machine filter"
        className="bg-bg-secondary w-full rounded p-1"
        value={filter}
        onChange={(event) => useRemoteLanesStore.getState().setFilter(event.target.value)}
      >
        <option value="all">All machines</option>
        <option value="local">This Mac</option>
        {readable.map(([id]) => (
          <option key={id} value={id}>
            {machineLabel(id)}
          </option>
        ))}
      </select>
      {readable
        .filter(([id]) => filter === 'all' || filter === id)
        .map(([id, host]) => (
          <section
            key={id}
            aria-label={machineLabel(id)}
            className={host.state === 'ready' ? '' : 'opacity-50'}
          >
            <div className="text-text-secondary text-sm">
              {machineLabel(id)}
              {host.state !== 'ready' && ' is offline'}
            </div>
            {host.lanes.map((lane) => (
              <TooltipButton
                type="button"
                key={lane.laneId}
                disabled={host.state !== 'ready'}
                aria-current={
                  active?.target?.kind === 'remote' &&
                  active.target.hostId === id &&
                  active.laneId === lane.laneId
                    ? 'page'
                    : undefined
                }
                className="hover:bg-bg-secondary block w-full truncate rounded px-2 py-1 text-left"
                onClick={() => void openRemoteLane(id, lane.laneId)}
              >
                {lane.attention > lane.read && <span aria-label="Unread">● </span>}
                {lane.title || 'Untitled lane'}{' '}
                <span className="text-text-tertiary text-sm">
                  {machineLabel(id)} · {lane.activity}
                </span>
              </TooltipButton>
            ))}
            {host.state === 'ready' && host.capabilities.includes('sessions.control') && (
              <Button size="xs" onClick={() => setCreating(id)}>
                New lane on {machineLabel(id)}
              </Button>
            )}
          </section>
        ))}
      {error && <p role="alert">{error}</p>}
      {creating && <NewRemoteLane hostId={creating} onClose={() => setCreating(null)} />}
    </div>
  )
}

function NewRemoteLane({
  hostId,
  onClose,
}: {
  hostId: string
  onClose: () => void
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [repositoryId, setRepositoryId] = useState(host?.repositories[0]?.id ?? '')
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function create(): Promise<void> {
    if (busy || host?.state !== 'ready' || !host.capabilities.includes('sessions.control')) return
    if (
      !host.repositories.some((repo) => repo.id === repositoryId) ||
      (branch && !isLaneBranchName(branch)) ||
      !!model !== !!provider
    ) {
      setError('Choose a repository, a valid branch, and both provider and model or neither.')
      return
    }
    setBusy(true)
    const nav = useSessionsStore.getState().claimNav()
    try {
      const info = await window.phosphor.invoke('hosts:createLane', hostId, {
        repositoryId,
        ...(branch ? { worktree: { branch } } : {}),
        ...(name ? { name } : {}),
        ...(model ? { model, provider } : {}),
      })
      await adoptRemoteLane(info, nav)
      onClose()
    } catch {
      setError('The Host could not confirm creation. Check the lane list before retrying.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={onClose}>
      <form
        className="bg-surface w-96 space-y-3 rounded-lg p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <h2>New lane on {machineLabel(hostId)}</h2>
        <label className="block">
          Repository
          <select
            aria-label="Repository"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            {host?.repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <TextInput
          aria-label="New branch (optional)"
          placeholder="New branch (optional)"
          maxLength={200}
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
        />
        <TextInput
          aria-label="Lane name (optional)"
          placeholder="Name (optional)"
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextInput
          aria-label="Provider (optional)"
          placeholder="Provider (optional)"
          maxLength={200}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        />
        <TextInput
          aria-label="Model (optional)"
          placeholder="Model (optional)"
          maxLength={200}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy || !repositoryId}>
          Create lane
        </Button>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
      </form>
    </ModalOverlay>
  )
}
