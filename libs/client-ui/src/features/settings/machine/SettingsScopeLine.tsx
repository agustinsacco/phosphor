import { localMachineLabel } from '@/lib/localMachine'
import type { SettingsMachineChoice } from '../SettingsMachineScope'

/**
 * The scope line above every machine section: which machine it configures,
 * then the section's scope controls (`ScopeRow`, a Host's Refresh). Views
 * never render a scope control of their own.
 */
export function SettingsScopeLine({
  machine,
  children,
}: {
  machine: SettingsMachineChoice
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="settings-scope-line"
      className="border-border bg-bg-secondary mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2"
    >
      <p
        className="text-text min-w-0 grow basis-64 text-base font-medium"
        data-testid="settings-machine-scope"
      >
        Configuring {machine.label}
        <span className="text-text-secondary font-normal">
          {machine.id === 'local'
            ? `. These settings stay on ${localMachineLabel()}.`
            : '. Credentials stay on this Host; nothing syncs to another machine.'}
        </span>
      </p>
      {children}
    </div>
  )
}
