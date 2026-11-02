import type { MachineSettingsSection } from '@shared/machine-settings'
import { HostProgramDialog } from '@/features/settings/machine/HostProgramDialog'
import { MachineSettingsGate } from './MachineSettingsLayout'
import type { MachineSettingsController } from './useMachineSettingsController'
export type MachineSettingsTab = MachineSettingsSection | 'folders'
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
