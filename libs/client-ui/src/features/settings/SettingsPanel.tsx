import { HostGate } from './machine/HostGate'
import { HostSectionProvider } from './machine/HostSection'
import { HostRefresh, HostScopeRow } from './machine/HostScopeControls'
import { LocalRefresh } from './machine/ScopeRefresh'
import { LocalScopeRow } from './machine/ScopeRow'
import { SettingsScopeLine } from './machine/SettingsScopeLine'
import { SETTINGS_SECTIONS } from './sections/registry'
import { findSection } from './settingsIndex'
import type { SettingsMachineChoice } from './SettingsMachineScope'
import type { SettingsTab } from './settingsUiStore'

/**
 * The open section, from the section registry. A machine section renders for
 * the machine chosen in Configure, under the scope line: This Mac's view, or
 * a Host's behind its gate. This Mac's views never mount while a Host is chosen.
 */
export function SettingsPanel({
  tab,
  machine,
}: {
  tab: SettingsTab
  machine: SettingsMachineChoice | null
}): React.JSX.Element | null {
  const section = findSection(tab)
  const views = SETTINGS_SECTIONS[tab]
  if (section?.scope !== 'machine') return views.Device ? <views.Device /> : null
  if (!machine) return null
  if (machine.id === 'local')
    return views.Local ? (
      <>
        <SettingsScopeLine machine={machine}>
          {views.scoped && <LocalScopeRow />}
          <LocalRefresh />
        </SettingsScopeLine>
        <views.Local />
      </>
    ) : null
  if (!views.Host || !section.host) return null
  return (
    <HostSectionProvider
      key={machine.id}
      machine={machine}
      section={section.host}
      scoped={views.scoped === true}
    >
      <SettingsScopeLine machine={machine}>
        {views.scoped && <HostScopeRow />}
        <HostRefresh />
      </SettingsScopeLine>
      <div data-testid="settings-host-section">
        <HostGate>
          <views.Host />
        </HostGate>
      </div>
    </HostSectionProvider>
  )
}
