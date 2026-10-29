import type { MachineSettingsTab } from './MachineSettings'

/** Host machine settings sections and their labels, in navigation order. */
export const MACHINE_SETTINGS_TABS: ReadonlyArray<readonly [MachineSettingsTab, string]> = [
  ['providers', 'Providers'],
  ['connectors', 'Connectors'],
  ['agent', 'Agent defaults'],
  ['folders', 'Folders'],
  ['resources', 'Skills & extensions'],
  ['advanced', 'Advanced'],
]
