import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useState } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import { HostFolderBrowser } from './HostFolderBrowser'
import type { MachinePrograms } from './MachineProviderSettings'
import { Card } from './MachineUi'

import type { Dispatch, SetStateAction } from 'react'
export function MachineFolderSettings({
  hostId,
  label,
  programs,
}: {
  hostId: string
  label: string
  programs: MachinePrograms
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Folders</h2>
          <p className="text-text-secondary mt-1 text-base">
            Folders registered on {label}. These are Host paths, never this computer’s files.
          </p>
        </div>
        <Button
          disabled={busy || !host?.capabilities.includes('workspaces.write')}
          onClick={() => setAdding(true)}
        >
          Add folder
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-danger text-base">
          {error}
        </p>
      )}
      <Card title="Configured repositories">
        {host?.repositories.map((repo) => (
          <MachineFolderRow
            key={repo.id}
            {...{ repo, host, hostId, label, programs, busy, setBusy, setError }}
          />
        ))}
        {!host?.repositories.length && (
          <p className="text-text-secondary text-base">No registered folders yet.</p>
        )}
      </Card>
      <p className="text-text-tertiary text-sm">
        Registration is not a filesystem sandbox. Project trust is separate: it permits pi to load
        project configuration and executable MCP commands. Review that code before approving.
      </p>
      {adding && (
        <HostFolderBrowser
          hostId={hostId}
          onClose={() => setAdding(false)}
          onAdded={() => setAdding(false)}
        />
      )}
    </div>
  )
}

function MachineFolderRow({
  repo,
  host,
  hostId,
  label,
  programs,
  busy,
  setBusy,
  setError,
}: {
  repo: HostConnectionView['repositories'][number]
  host: HostConnectionView | undefined
  hostId: string
  label: string
  programs: MachinePrograms
  busy: boolean
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
}): React.JSX.Element {
  return (
    <div
      key={repo.id}
      className="border-border flex flex-wrap items-center gap-3 border-b py-3 last:border-0"
    >
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-medium">{repo.name}</h3>
        <p className="text-text-secondary break-all font-mono text-sm">{repo.path}</p>
      </div>
      <Button
        size="xs"
        disabled={busy || programs.busy || !programs.available}
        onClick={() => programs.task({ task: 'folder.trust', repositoryId: repo.id })}
      >
        Review project trust
      </Button>
      <Button
        size="xs"
        disabled={busy || !host?.capabilities.includes('workspaces.write')}
        onClick={() =>
          void (async () => {
            if (
              (await promptChoice({
                title: `Unregister ${repo.name} on ${label}?`,
                message:
                  'Files are never deleted. Existing lane history remains. A folder with active lanes may refuse removal.',
                choices: [{ value: 'remove', label: 'Unregister folder', primary: true }],
              })) !== 'remove'
            )
              return
            setBusy(true)
            setError(null)
            try {
              await window.phosphor.invoke('hosts:removeRepository', hostId, repo.id)
            } catch {
              setError('Folder removal not confirmed. Refresh the Host before trying again.')
            } finally {
              setBusy(false)
            }
          })()
        }
      >
        Unregister
      </Button>
    </div>
  )
}
