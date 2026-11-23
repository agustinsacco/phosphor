import { setFolderDirective } from './folder-directives'
import { changeAgentConnector } from './connector-settings'
import { SettingsContext, type MachineSettingsOptions } from './context'
import { createSettingsFeature } from './feature'
import { createSettingsSnapshot } from './snapshot'

export function createMachineSettings(options: MachineSettingsOptions) {
  const state = new SettingsContext(options)
  const snapshot = createSettingsSnapshot(state)
  return {
    setFolderDirective: setFolderDirective.bind(null, state),
    changeAgentConnector: changeAgentConnector.bind(null, state),
    feature: createSettingsFeature(state, snapshot),
    snapshot,
    workspace: state.workspace,
    agentDir: state.agentDir,
    invalidateConnectors: state.invalidateConnectors,
  }
}
