import type { SettingsTab } from '../settingsUiStore'
import { AboutTab } from '../tabs/AboutTab'
import { AccountTab } from '../tabs/AccountTab'
import { AccountsTab } from '../tabs/AccountsTab'
import { AdvancedTab } from '../tabs/AdvancedTab'
import { AgentTab } from '../tabs/AgentTab'
import { AppearanceTab } from '../tabs/AppearanceTab'
import { ClaudeProviderTab } from '../tabs/ClaudeProviderTab'
import { ComputerUseTab } from '../tabs/ComputerUseTab'
import { ExtensionsTab } from '../tabs/ExtensionsTab'
import { InstallAppTab } from '../tabs/InstallAppTab'
import { KeybindingsTab } from '../tabs/KeybindingsTab'
import { OptimizationTab } from '../tabs/OptimizationTab'
import { SubagentsTab } from '../tabs/SubagentsTab'
import { VoiceTab } from '../tabs/VoiceTab'
import { WebAccessTab } from '../tabs/WebAccessTab'
import { WorkspacesTab } from '../tabs/WorkspacesTab'
import { WritingTab } from '../tabs/WritingTab'
import {
  HostAccountsSection,
  HostAdvancedSection,
  HostAgentSection,
  HostExtensionsSection,
  HostFoldersSection,
} from './hostSections'
import { HostConnectors, LocalConnectors } from './connectors'

type View = () => React.JSX.Element

/**
 * What renders for one section. `SettingsPanel` renders `Device` alone,
 * `Local` for This Mac, and `Host` inside `HostSectionProvider` › `HostGate`
 * for a Host. Nothing else in Settings branches on the kind of machine.
 */
export interface SettingsSectionViews {
  /** A device section: configures this client, whichever machine is chosen. */
  Device?: View
  Local?: View
  Host?: View
  /** The scope line offers Machine or one folder; the views read `folder` from the store. */
  scoped?: boolean
}

export const SETTINGS_SECTIONS: Record<SettingsTab, SettingsSectionViews> = {
  appearance: { Device: AppearanceTab },
  writing: { Device: WritingTab },
  keybindings: { Device: KeybindingsTab },
  account: { Device: AccountTab },
  install: { Device: InstallAppTab },
  about: { Device: AboutTab },
  agent: { Local: AgentTab, Host: HostAgentSection, scoped: true },
  accounts: { Local: AccountsTab, Host: HostAccountsSection },
  extensions: { Local: ExtensionsTab, Host: HostExtensionsSection },
  'claude-provider': { Local: ClaudeProviderTab },
  'web-access': { Local: WebAccessTab },
  'computer-use': { Local: ComputerUseTab },
  subagents: { Local: SubagentsTab },
  connectors: { Local: LocalConnectors, Host: HostConnectors, scoped: true },
  workspaces: { Local: WorkspacesTab },
  folders: { Host: HostFoldersSection },
  optimization: { Local: OptimizationTab },
  voice: { Local: VoiceTab },
  advanced: { Local: AdvancedTab, Host: HostAdvancedSection },
}
