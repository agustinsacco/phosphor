import { LOCAL_ONLY, onHost, section, type SettingEntry } from '../settingEntry'

/** Advanced: This Mac's rows, until a view every machine shares renders them. */
export const ADVANCED_ROWS: SettingEntry[] = [
  ...section(
    'advanced',
    null,
    [
      ['pi health', 'version install'],
      ['pi settings.json', 'config edit raw'],
      ['pi models.json', 'custom providers local endpoints'],
    ],
    LOCAL_ONLY,
  ),
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

/**
 * The Host's Advanced panel, by the heading it renders. It has no raw editors:
 * it shows Host updates, the runtime, environment availability and PATH.
 */
export const ADVANCED_HOST_HEADING: SettingEntry[] = onHost('advanced', [
  'Advanced',
  'Host updates version runtime config agent directory environment path',
])
