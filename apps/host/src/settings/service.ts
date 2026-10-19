import { SettingsContext, type MachineSettingsOptions } from './context'
import { createSettingsFeature } from './feature'
import { createSettingsSnapshot } from './snapshot'

export function createMachineSettings(options: MachineSettingsOptions) {
  const state = new SettingsContext(options)
  const snapshot = createSettingsSnapshot(state)
  return {
    feature: createSettingsFeature(state, snapshot),
    snapshot,
    workspace: state.workspace,
    agentDir: state.agentDir,
    invalidateConnectors: state.invalidateConnectors,
  }
}
