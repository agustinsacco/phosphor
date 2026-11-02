import { Button } from '@/components/form'
import { errorText } from '@shared/errors'
import { CopyCommand } from './MachineControls'

import { ConfiguredMachineSettings } from './MachineConfiguredSettings'
import type { MachineSettingsController } from './useMachineSettingsController'
type ControllerProps = { controller: MachineSettingsController }

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
