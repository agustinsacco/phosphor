import { Button } from '@/components/form'
import { confirmSettingsNavigation } from './machineSettingsDrafts'
import { Skeleton, Spinner } from './MachineUi'

import { MachineSettingsPanels } from './MachineSettingsPanels'
import type { MachineSettingsController } from './useMachineSettingsController'
type ControllerProps = { controller: MachineSettingsController }

export function ConfiguredMachineSettings({ controller }: ControllerProps): React.JSX.Element {
  const { machine, settings, terminals, starting } = controller
  return (
    <>
      <MachineSettingsToolbar controller={controller} />
      {!terminals && (
        <p className="text-warning text-base">
          Native Host terminal support is unavailable or not granted. Sign-in and setup actions are
          disabled; read-only checks remain available.
        </p>
      )}
      {starting && (
        <p role="status" className="text-text-secondary flex items-center gap-2 text-base">
          <Spinner />
          Starting the private program on {machine.label}…
        </p>
      )}
      {settings.loading && !settings.data ? (
        <div
          role="status"
          aria-label="Loading machine settings"
          className="space-y-4 rounded-lg py-4"
        >
          <Skeleton className="h-5 w-40" />
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      ) : settings.data ? (
        <MachineSettingsPanels controller={controller} />
      ) : (
        <p className="text-text-secondary text-base">
          No Host settings were loaded. Refresh to try again.
        </p>
      )}
    </>
  )
}

function MachineSettingsToolbar({ controller }: ControllerProps): React.JSX.Element {
  const { machine, settings, scoped, repositoryId, setRepositoryId, connection, starting } =
    controller
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {scoped ? (
        <label className="text-text-secondary flex items-center gap-2 text-sm">
          Configuration scope
          <select
            aria-label="Host configuration scope"
            value={repositoryId ?? ''}
            onChange={(e) => {
              const next = e.target.value || undefined
              e.currentTarget.value = repositoryId ?? ''
              void (async () => {
                if (await confirmSettingsNavigation(machine.id)) setRepositoryId(next)
              })()
            }}
            disabled={settings.saving || starting}
            className="border-border bg-bg max-w-72 rounded-md border p-1.5"
          >
            <option value="">{machine.label} · machine defaults</option>
            {connection?.repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name} · folder only
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="text-text-tertiary text-sm">Machine-wide settings</span>
      )}
      <Button
        size="xs"
        disabled={settings.loading || settings.saving || starting}
        onClick={() =>
          void (async () => {
            if (await confirmSettingsNavigation(machine.id)) await settings.refresh()
          })()
        }
      >
        {settings.loading ? 'Reading Host settings…' : 'Refresh'}
      </Button>
    </div>
  )
}
