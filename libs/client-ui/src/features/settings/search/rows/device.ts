import { formatShortcut } from '@/lib/shortcuts'
import { keybindingGroups } from '../../tabs/KeybindingsTab'
import { section, type SettingEntry } from '../settingEntry'

/** Device sections: they configure this client, so every machine finds them. */
export const APPEARANCE_ROWS: SettingEntry[] = section('appearance', null, [
  ['Theme', 'dark light mode colour color system'],
  ['UI scale', 'zoom size interface', 'pageZoom'],
  ['Chat font size', 'text transcript'],
  ['Editor font size', 'monaco diff text'],
  ['Terminal font size', 'shell text', 'terminal'],
  ['Mono font', 'monospace typeface family code'],
])

export const WRITING_ROWS: SettingEntry[] = section('writing', null, [
  ['Check spelling', 'spellcheck typo misspelled dictionary correct'],
  ['Autocomplete', 'suggestions predict next word ghost text complete'],
  ['Learned prompts', 'history clear forget autocomplete'],
])

export const ACCOUNT_ROWS: SettingEntry[] = section('account', null, [
  ['Signed in', 'github user sign out log out'],
  ['Not signed in', 'github sign in login'],
])

export const INSTALL_ROWS: SettingEntry[] = [
  ...section('install', null, [['Install', 'pwa home screen app']]),
  ...section('install', ['Notifications', 'push alerts attention']),
]

export const ABOUT_ROWS: SettingEntry[] = section('about', null, [
  ['Phosphor version', 'release', 'appInfo'],
  ['Updates', 'upgrade release download', 'appInfo'],
  ['pi version', 'pi health', 'appInfo'],
  ['Platform', 'os macos linux windows', 'appInfo'],
  ['Runtime', 'electron node chrome', 'appInfo'],
])

/** Every keybinding, under its group, with its keys. */
export const KEYBINDING_ROWS: SettingEntry[] = keybindingGroups().flatMap(({ title, bindings }) =>
  section('keybindings', title).concat(
    bindings.map<SettingEntry>(([parts, action]) => ({
      tab: 'keybindings',
      title: action,
      section: title,
      keywords: 'shortcut hotkey key',
      detail: formatShortcut(...parts),
    })),
  ),
)
