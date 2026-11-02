import { section, type SettingEntry } from '../settingEntry'

/** Workspaces: This Mac's section only. */
export const WORKSPACES_ROWS: SettingEntry[] = [
  ...section('workspaces', 'Naming and markers', [
    ['Name sessions automatically', 'auto title rename'],
    'Title length',
    'Title character limit',
    ['Branch name length', 'slug git'],
    ['Lane markers', 'emoji icon'],
    ['PR status on lanes', 'github pull request checks'],
  ]),
  ...section('workspaces', 'New sessions', [
    ['Give each chat its own branch', 'worktree git'],
    ['Branch prefix', 'git'],
  ]),
  ...section('workspaces', ['Workspaces', 'recent folders projects']),
  ...section('workspaces', ['Sandboxes', 'scratch no folder']),
]
