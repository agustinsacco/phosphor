import { section, type SettingEntry } from '../settingEntry'

/** Lanes: this device's lane display and branch naming, whichever machine is chosen. */
export const LANES_ROWS: SettingEntry[] = [
  ...section('lanes', null, [
    ['Lane markers', 'emoji icon'],
    ['PR status on lanes', 'github pull request checks'],
  ]),
  ...section(
    'lanes',
    ['New lanes', 'sessions workspaces'],
    [
      ['Give each chat its own branch', 'worktree git isolate', 'localLanes'],
      ['Branch prefix', 'git'],
      ['Branch name length', 'slug git'],
    ],
  ),
]
