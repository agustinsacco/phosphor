import { LOCAL_ONLY, onHost, section, type SettingEntry } from '../settingEntry'

/** Extensions: This Mac's rows, until a view every machine shares renders them. */
export const EXTENSIONS_ROWS: SettingEntry[] = [
  ...section(
    'extensions',
    null,
    [
      ['Recommended', 'packages catalogue'],
      ['Add a package', 'install npm git'],
    ],
    LOCAL_ONLY,
  ),
]

/** The extension pages nested under Extensions. Claude Code's are on every machine. */
export const CLAUDE_PROVIDER_ROWS: SettingEntry[] = [
  ...section('claude-provider', null, [
    ['Health', 'claude cli version install'],
    ['When it fails', 'troubleshoot error debug'],
    ['Accounts', 'claude login sign in'],
    ['Route new sessions', 'claude account'],
  ]),
  // A Host does not run the end-to-end test yet.
  ...section('claude-provider', null, [['Prove it end to end', 'test check']], LOCAL_ONLY),
]

export const WEB_ACCESS_ROWS: SettingEntry[] = section('web-access', null, [
  ['Search providers', 'web fetch api key'],
])

export const SUBAGENTS_ROWS: SettingEntry[] = [
  ...section('subagents', ['How delegation works', 'background foreground workflow parent child']),
  ...section('subagents', [
    'Profiles and precedence',
    'scout worker reviewer oracle agents markdown',
  ]),
  ...section('subagents', ['Context and permissions', 'fresh fork sandbox safety tools']),
  ...section(
    'subagents',
    ['Configuration sources', 'settings json overrides runtime timeout concurrency'],
    [
      ['Pi settings', 'defaultModel defaultProvider agentOverrides'],
      ['Delegation policy', 'directives authorization'],
    ],
  ),
  ...section('subagents', [
    'Results and storage',
    'artifacts sessions lifecycle history acceptance',
  ]),
]

/** The Host's Extensions panel, by the heading it renders. */
export const EXTENSIONS_HOST_HEADING: SettingEntry[] = onHost('extensions', [
  'Extensions',
  'Host skills packages',
])
