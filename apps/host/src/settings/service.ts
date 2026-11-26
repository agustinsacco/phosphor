import { setFolderDirective } from './folder-directives'
import { changeAgentConnector } from './connector-settings'
import { SettingsContext, type MachineSettingsOptions } from './context'
import { createSettingsFeature } from './feature'
import { hostCodexUsage, usageAccounts } from '../providers/machine-usage'
import { readAccountSettings } from './provider-settings'
import { createSettingsSnapshot } from './snapshot'

export function createMachineSettings(options: MachineSettingsOptions) {
  const state = new SettingsContext(options)
  const snapshot = createSettingsSnapshot(state)
  return {
    setFolderDirective: setFolderDirective.bind(null, state),
    changeAgentConnector: changeAgentConnector.bind(null, state),
    feature: createSettingsFeature(state, snapshot),
    snapshot,
    accountMetadata: readAccountSettings.bind(null, state),
    usageAccounts: usageAccounts.bind(null, options.accounts),
    codexUsage: hostCodexUsage(options.pi, options.env),
    workspace: state.workspace,
    agentDir: state.agentDir,
    invalidateConnectors: state.invalidateConnectors,
  }
}
