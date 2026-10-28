import { MachineSettingsBody, type MachineSettingsTab } from '@/features/machines/MachineSettings'
import { useMachineSettingsController } from '@/features/machines/useMachineSettingsController'
import { isHostTab, isThisMacTab } from './settingsIndex'
import { SettingsMachineScope, type SettingsMachineChoice } from './SettingsMachineScope'
import type { HostSettingsTab, SettingsTab } from './settingsUiStore'
import { AppearanceTab } from './tabs/AppearanceTab'
import { WritingTab } from './tabs/WritingTab'
import { AgentTab } from './tabs/AgentTab'
import { AccountsTab } from './tabs/AccountsTab'
import { ExtensionsTab } from './tabs/ExtensionsTab'
import { ClaudeProviderTab } from './tabs/ClaudeProviderTab'
import { WebAccessTab } from './tabs/WebAccessTab'
import { WorkspacesTab } from './tabs/WorkspacesTab'
import { OptimizationTab } from './tabs/OptimizationTab'
import { AdvancedTab } from './tabs/AdvancedTab'
import { VoiceTab } from './tabs/VoiceTab'
import { ConnectorsTab } from './tabs/ConnectorsTab'
import { ComputerUseTab } from './tabs/ComputerUseTab'
import { SubagentsTab } from './tabs/SubagentsTab'
import { KeybindingsTab } from './tabs/KeybindingsTab'
import { AccountTab } from './tabs/AccountTab'
import { InstallAppTab } from './tabs/InstallAppTab'
import { AboutTab } from './tabs/AboutTab'

const DEVICE_TABS: Partial<Record<SettingsTab, () => React.JSX.Element>> = {
  appearance: AppearanceTab,
  writing: WritingTab,
  keybindings: KeybindingsTab,
  account: AccountTab,
  install: InstallAppTab,
  about: AboutTab,
}
const THIS_MAC_TABS: Partial<Record<SettingsTab, () => React.JSX.Element>> = {
  agent: AgentTab,
  accounts: AccountsTab,
  extensions: ExtensionsTab,
  'claude-provider': ClaudeProviderTab,
  'web-access': WebAccessTab,
  connectors: ConnectorsTab,
  'computer-use': ComputerUseTab,
  subagents: SubagentsTab,
  workspaces: WorkspacesTab,
  optimization: OptimizationTab,
  voice: VoiceTab,
  advanced: AdvancedTab,
}

/**
 * The open section. Machine sections render only for the machine they belong
 * to, under the scope line: This Mac's tabs never mount while a Host is chosen.
 */
export function SettingsPanel({
  tab,
  machine,
}: {
  tab: SettingsTab
  machine: SettingsMachineChoice | null
}): React.JSX.Element | null {
  if (isHostTab(tab))
    return machine && machine.id !== 'local' ? (
      <>
        <SettingsMachineScope machine={machine} />
        <HostSettingsSection key={machine.id} machine={machine} tab={tab as HostSettingsTab} />
      </>
    ) : null
  if (isThisMacTab(tab)) {
    const Tab = THIS_MAC_TABS[tab]
    return machine?.id === 'local' && Tab ? (
      <>
        <SettingsMachineScope machine={machine} />
        <Tab />
      </>
    ) : null
  }
  const Tab = DEVICE_TABS[tab]
  return Tab ? <Tab /> : null
}

/** One Host machine settings section through the shared controller and gate. */
function HostSettingsSection({
  machine,
  tab,
}: {
  machine: SettingsMachineChoice
  tab: HostSettingsTab
}): React.JSX.Element {
  const section = tab.slice('host-'.length) as MachineSettingsTab
  const controller = useMachineSettingsController(machine, section)
  return (
    <div data-testid="settings-host-section">
      <MachineSettingsBody controller={controller} />
    </div>
  )
}
