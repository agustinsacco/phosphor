import { LOCAL_ONLY, section, type SettingEntry } from '../settingEntry'

const HOST_ONLY = { host: true }

/** One permanent local heading; even searches for actions that are currently hidden land here. */
export const SERVICE_SECTION_ENTRY: SettingEntry = {
  tab: 'advanced',
  title: 'Phosphor service',
  on: LOCAL_ONLY,
  requires: 'localLanes',
  keywords: 'update restart migration retry export diagnostics quit lanes pause abort cancel',
}

/** Advanced: one view on every machine, each block where that machine has it. */
export const ADVANCED_ROWS: SettingEntry[] = [
  SERVICE_SECTION_ENTRY,
  ...section(
    'advanced',
    null,
    [
      ['Software', 'host updates update upgrade version phosphor update pause runtime platform'],
      ['Host config', 'configuration file path'],
    ],
    HOST_ONLY,
  ),
  ...section(
    'advanced',
    null,
    [
      ['Phosphor updates', 'update upgrade version check now restart'],
      ['Phosphor version', 'runtime platform app'],
    ],
    LOCAL_ONLY,
  ),
  ...section('advanced', null, [
    ['pi health', 'version install binary'],
    ['pi agent directory', 'agent dir folder'],
  ]),
  ...section(
    'advanced',
    null,
    [
      ['pi settings.json', 'config edit raw'],
      ['pi models.json', 'custom providers local endpoints'],
    ],
    LOCAL_ONLY,
  ),
  ...section('advanced', ['Executable search path', 'PATH binaries not found']),
  ...section('advanced', ['Environment availability', 'env variables secrets'], [], HOST_ONLY),
  ...section(
    'advanced',
    ['Maintenance', 'cleanup disk worktrees'],
    [
      ['Reclaim dead lanes', 'worktrees merged sweep'],
      ['Sweep every', 'interval'],
      'Leave lanes alone for',
      ['Delete automatically', 'remove'],
    ],
    LOCAL_ONLY,
  ),
  ...section('advanced', ['Local pi resources', 'prompts themes extensions'], [], LOCAL_ONLY),
]
