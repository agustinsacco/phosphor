import { LOCAL_ONLY, section, type SettingEntry } from '../settingEntry'

/** Folders: one view on every machine; only This Mac has sandboxes. */
export const FOLDERS_ROWS: SettingEntry[] = [
  ...section('folders', ['Folders', 'workspaces recent projects repositories registered trust']),
  ...section('folders', ['Sandboxes', 'scratch no folder'], [], LOCAL_ONLY),
]
