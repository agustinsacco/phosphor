import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { errorText } from '@shared/errors'
import { CopyCommand } from './MachineControls'

import { ConfiguredMachineSettings } from './MachineConfiguredSettings'
import { MACHINE_SETTINGS_TABS } from './machineSettingsTabs'
import type { MachineSettingsController } from './useMachineSettingsController'
type ControllerProps = { controller: MachineSettingsController }

export function MachineSettingsNavigation({ controller }: ControllerProps): React.JSX.Element {
  const { machine, section, settings, starting, select } = controller
  return (
    <nav
      aria-label="Machine settings"
      className="flex gap-1 overflow-x-auto md:w-40 md:shrink-0 md:flex-col"
    >
      {MACHINE_SETTINGS_TABS.map(([key, title]) => (
        <TooltipButton
          key={key}
          tooltip={`${title} on ${machine.label}`}
          aria-current={key === section ? 'page' : undefined}
          className={`shrink-0 rounded-md px-3 py-2 text-left text-base transition-colors ${key === section ? 'bg-surface-raised text-text' : 'text-text-secondary hover:bg-bg-secondary'}`}
          disabled={settings.saving || starting}
          onClick={() => void select(key)}
        >
          {title}
        </TooltipButton>
      ))}
    </nav>
  )
}

export function MachineSettingsGate({ controller }: ControllerProps): React.JSX.Element {
  const { machine, settings, connection, allowed, accessBusy, access, setError } = controller
  return (
    <>
      {!settings.supported ? (
        <p className="text-text-secondary text-base">
          Machine configuration is available in Phosphor Desktop. Open this Host’s Settings there.
        </p>
      ) : !connection || connection.state !== 'ready' ? (
        <div className="border-border space-y-3 rounded-lg border p-4">
          <h2 className="text-xl font-semibold">Connect to {machine.label} first</h2>
          <p className="text-text-secondary text-base">
            Settings cannot be loaded or changed while this Host is unavailable. Nothing is queued
            for later, and this computer’s settings are never substituted.
          </p>
          <Button
            size="sm"
            disabled={accessBusy}
            onClick={() =>
              void window.phosphor
                .invoke('hosts:reconnect', machine.id)
                .catch((e) => setError(errorText(e)))
            }
          >
            Reconnect
          </Button>
        </div>
      ) : !connection.configurationSupported ? (
        <div className="border-border space-y-3 rounded-lg border p-4">
          <h2 className="text-xl font-semibold">Update the Host to use machine settings</h2>
          <p className="text-text-secondary text-base">
            This version of {machine.label} does not offer the machine settings API. Run this on the
            Host, then reconnect:
          </p>
          <CopyCommand command="phosphor update" />
        </div>
      ) : !allowed ? (
        <div className="border-border space-y-3 rounded-lg border p-4">
          <h2 className="text-xl font-semibold">Configuration access is not enabled</h2>
          <p className="text-text-secondary text-base">
            Viewing lanes and controlling a session do not automatically permit machine-wide
            configuration. Explicitly enable settings access for this client.
          </p>
          <Button disabled={accessBusy} onClick={() => void access()}>
            {accessBusy ? 'Enabling access…' : 'Enable configuration access'}
          </Button>
        </div>
      ) : (
        <ConfiguredMachineSettings controller={controller} />
      )}
    </>
  )
}
