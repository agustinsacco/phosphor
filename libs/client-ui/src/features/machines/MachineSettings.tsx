import type { MachineView } from '@shared/control-api'
import type { MachineSettingsSection } from '@shared/machine-settings'
import { HostProgramDialog } from './HostProgramDialog'
import { MachineSettingsGate, MachineSettingsNavigation } from './MachineSettingsLayout'
import {
  useMachineSettingsController,
  type MachineSettingsController,
} from './useMachineSettingsController'
export type MachineSettingsTab = MachineSettingsSection | 'folders'
export function MachineSettings({
  machine,
  section,
}: {
  machine: Pick<MachineView, 'id' | 'label'>
  section: MachineSettingsTab
}): React.JSX.Element {
  const controller = useMachineSettingsController(machine, section)
  return (
    <section
      aria-label={`Settings on ${machine.label}`}
      className="space-y-4"
      data-testid="machine-settings"
    >
      <div className="border-info/25 bg-info/5 rounded-lg border px-4 py-3">
        <p className="text-lg font-medium">Configuring {machine.label}, not this computer.</p>
        <p className="text-text-secondary mt-1 text-base">
          Credentials stay on this Host. Nothing automatically syncs to another machine.
        </p>
      </div>
      <div className="flex flex-col gap-5 md:flex-row">
        <MachineSettingsNavigation controller={controller} />
        <MachineSettingsBody controller={controller} />
      </div>
    </section>
  )
}

/** One Host section behind its gate, with its errors and program dialog; Settings hosts the nav. */
export function MachineSettingsBody({
  controller,
}: {
  controller: MachineSettingsController
}): React.JSX.Element {
  const { machine, settings, error, program, setProgram } = controller
  return (
    <div className="min-w-0 flex-1 space-y-4">
      {(error || settings.error) && (
        <p role="alert" className="text-danger text-base">
          {error ?? settings.error}
        </p>
      )}
      <MachineSettingsGate controller={controller} />
      {program && (
        <HostProgramDialog
          hostLabel={machine.label}
          {...program}
          onClose={() => {
            setProgram(null)
            void settings.refresh()
          }}
          onSettled={() => void settings.refresh()}
        />
      )}
    </div>
  )
}
