import { onHost, type SettingEntry } from '../settingEntry'

/** Folders: the Host's section only, by the heading its panel renders. */
export const FOLDERS_ROWS: SettingEntry[] = onHost('folders', [
  'Folders',
  'Host repositories projects',
])
