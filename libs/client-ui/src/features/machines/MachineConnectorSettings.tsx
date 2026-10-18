import { useState } from 'react'
import { AddHostConnector } from './AddHostConnector'
import { HostConnectorHeading, HostConnectorRow, saveHostConnector } from './HostConnectorSections'
import type { MachinePrograms } from './MachineProviderSettings'
import { Card } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'
export function MachineConnectorSettings({
  label,
  settings,
  programs,
  repositoryId,
}: {
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
  repositoryId?: string
}): React.JSX.Element | null {
  const [adding, setAdding] = useState(false)
  const state = settings.data?.connectors
  if (!state) return null
  const busy = settings.loading || settings.saving || programs.busy
  return (
    <div className="space-y-4">
      <HostConnectorHeading {...{ label, settings, state, busy, setAdding }} />
      <Card
        title="Configured on this Host"
        aside={
          state.checkedAt
            ? `Checked ${new Date(state.checkedAt).toLocaleTimeString()}`
            : 'Status not checked yet'
        }
      >
        {!state.servers.length ? (
          <p className="text-text-secondary text-base">
            No connectors in this scope yet. Add one and sign in on {label}.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {state.servers.map((server) => (
              <HostConnectorRow
                key={server.name}
                {...{ label, settings, programs, repositoryId, state, busy, server }}
              />
            ))}
          </ul>
        )}
      </Card>
      <p className="text-text-tertiary text-sm">
        New lanes read the saved configuration. Existing lanes keep their current tools until
        explicitly reloaded. Sign-in is only marked connected after a status check, not just because
        a browser opened.
      </p>
      {adding && (
        <AddHostConnector
          key={repositoryId ?? 'machine'}
          label={label}
          busy={busy}
          onClose={() => setAdding(false)}
          onSave={(name, config) =>
            saveHostConnector({ settings, label, repositoryId, setAdding }, name, config)
          }
        />
      )}
    </div>
  )
}
