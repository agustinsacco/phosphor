import type { SettingsTab } from '../settingsUiStore'
import { AboutTab } from '../tabs/AboutTab'
import { AccountTab } from '../tabs/AccountTab'
import { AppearanceTab } from '../tabs/AppearanceTab'
import { InstallAppTab } from '../tabs/InstallAppTab'
import { KeybindingsTab } from '../tabs/KeybindingsTab'
import { OptimizationTab } from '../tabs/OptimizationTab'
import { BrainTab } from '../tabs/BrainTab'
import { VoiceTab } from '../tabs/VoiceTab'
import { WritingTab } from '../tabs/WritingTab'
import { HostAccounts, LocalAccounts } from './accounts'
import { HostAdvanced, LocalAdvanced } from './advanced'
import { HostAgent, LocalAgent } from './agent'
import { HostClaudeProvider, LocalClaudeProvider } from './claude-provider'
import { HostComputerUse, LocalComputerUse } from './computer-use'
import { HostConnectors, LocalConnectors } from './connectors'
import { HostExtensions, LocalExtensions } from './extensions'
import { HostFolders, LocalFolders } from './folders'
import { LanesSection } from './lanes/LanesSection'
import { HostSubagents, LocalSubagents } from './subagents'
import { HostWebAccess, LocalWebAccess } from './web-access'

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
  agent: { Local: LocalAgent, Host: HostAgent, scoped: true },
  accounts: { Local: LocalAccounts, Host: HostAccounts },
  extensions: { Local: LocalExtensions, Host: HostExtensions, scoped: true },
  'claude-provider': { Local: LocalClaudeProvider, Host: HostClaudeProvider },
  'web-access': { Local: LocalWebAccess, Host: HostWebAccess },
  'computer-use': { Local: LocalComputerUse, Host: HostComputerUse },
  subagents: { Local: LocalSubagents, Host: HostSubagents },
  connectors: { Local: LocalConnectors, Host: HostConnectors, scoped: true },
  lanes: { Device: LanesSection },
  folders: { Local: LocalFolders, Host: HostFolders },
  optimization: { Local: OptimizationTab },
  voice: { Device: VoiceTab },
  brain: { Device: BrainTab },
  advanced: { Local: LocalAdvanced, Host: HostAdvanced },
}
