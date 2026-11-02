import { SettingsMachineScope, type SettingsMachineChoice } from '../SettingsMachineScope'

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
      <SettingsMachineScope machine={machine} />
      {children}
    </div>
  )
}
