import type { PiPackageEntry } from '@shared/models'
import { formatShortcut } from '@/lib/shortcuts'
import type { Platform } from '@/platform/Platform'
import { MACHINE_SETTINGS_TABS } from '@/features/machines/machineSettingsTabs'
import type { SettingsTab } from './settingsUiStore'
import { keybindingGroups } from './tabs/KeybindingsTab'

/** A Platform flag a section or row needs. Never the form factor. */
export type SettingsCapability = Exclude<keyof Platform, 'formFactor'>

/** One entry in the Settings section navigation. */
export interface SettingsSection {
  id: SettingsTab
  label: string
  /** Device sections configure this client; machine sections the machine chosen in Configure. */
  scope: 'device' | 'machine'
  /** Machine sections only: This Mac's own tabs, or the Host machine settings. */
  machine?: 'local' | 'host'
  requires: readonly SettingsCapability[]
}

const device = (
  id: SettingsTab,
  label: string,
  requires: SettingsCapability[] = [],
): SettingsSection => ({ id, label, scope: 'device', requires })
const thisMac = (id: SettingsTab, label: string): SettingsSection => ({
  id,
  label,
  scope: 'machine',
  machine: 'local',
  requires: ['localLanes'],
})

/** Every top-level section, device sections first, in navigation order. */
export const TABS: SettingsSection[] = [
  device('appearance', 'Appearance'),
  device('writing', 'Writing', ['writingAssist']),
  device('keybindings', 'Keybindings', ['appShortcuts']),
  device('account', 'Phosphor account'),
  device('install', 'App installation', ['installableApp']),
  device('about', 'About'),
  thisMac('agent', 'Agent'),
  thisMac('accounts', 'Accounts'),
  thisMac('extensions', 'Extensions'),
  thisMac('connectors', 'MCP Connectors'),
  thisMac('workspaces', 'Workspaces'),
  thisMac('optimization', 'Optimization'),
  thisMac('voice', 'Voice'),
  thisMac('advanced', 'Advanced'),
  ...MACHINE_SETTINGS_TABS.map<SettingsSection>(([key, label]) => ({
    id: `host-${key}`,
    label,
    scope: 'machine',
    machine: 'host',
    requires: ['machineSettings'],
  })),
]

/**
 * Curated extensions contribute a tab only while their package is present.
 * They render nested under the Extensions entry in the sidebar — they are
 * configuration for an installed package, not top-level settings.
 */
export const EXTENSION_TABS: Array<
  SettingsSection & { packageMatch: string; requiresInstalled?: boolean }
> = [
  { ...thisMac('claude-provider', 'Claude Code'), packageMatch: 'pi-claude-cli' },
  { ...thisMac('web-access', 'Web access'), packageMatch: 'pi-web-access' },
  { ...thisMac('computer-use', 'Computer use'), packageMatch: '@injaneity/pi-computer-use' },
  {
    ...thisMac('subagents', 'Subagents'),
    packageMatch: 'pi-subagents',
    requiresInstalled: true,
  },
]

export function installedExtensionTabs(entries: PiPackageEntry[]): typeof EXTENSION_TABS {
  return EXTENSION_TABS.filter((tab) =>
    // Existing health/config tabs also help repair declared but absent packages.
    entries.some(
      (entry) =>
        (!tab.requiresInstalled || entry.installed) && entry.spec.includes(tab.packageMatch),
    ),
  )
}

export const tabLabel = (id: SettingsTab): string =>
  [...TABS, ...EXTENSION_TABS].find((t) => t.id === id)?.label ?? id

export const supports = (platform: Platform, requires: readonly SettingsCapability[]): boolean =>
  requires.every((capability) => platform[capability])

/**
 * The top-level sections this platform lists for the chosen machine kind: every
 * supported device section, then that machine's sections. Search uses the same set.
 */
export function visibleSections(
  platform: Platform,
  machine: 'local' | 'host' | null,
): SettingsSection[] {
  return TABS.filter(
    (tab) =>
      supports(platform, tab.requires) && (tab.scope === 'device' || tab.machine === machine),
  )
}

/** This Mac's machine tabs, including the extension tabs nested under Extensions. */
export function isThisMacTab(id: SettingsTab): boolean {
  return [...TABS, ...EXTENSION_TABS].some((t) => t.id === id && t.machine === 'local')
}

export function isHostTab(id: SettingsTab): boolean {
  return TABS.some((t) => t.id === id && t.machine === 'host')
}

/** The same concern on the other kind of machine, so switching machines keeps your place. */
const COUNTERPARTS: Array<[local: SettingsTab, host: SettingsTab]> = [
  ['accounts', 'host-providers'],
  ['agent', 'host-agent'],
  ['connectors', 'host-connectors'],
  ['extensions', 'host-resources'],
  ['advanced', 'host-advanced'],
]
export function counterpartTab(id: SettingsTab): SettingsTab | null {
  const pair = COUNTERPARTS.find(([local, host]) => local === id || host === id)
  return pair ? (pair[0] === id ? pair[1] : pair[0]) : null
}

/** One searchable place in settings. */
export interface SettingEntry {
  tab: SettingsTab
  /** A row the platform only renders with this capability. */
  requires?: SettingsCapability
  /** Exactly as the tab renders it: the result jumps to this text. */
  title: string
  /** The heading it sits under; unset for a heading itself. */
  section?: string
  /** Synonyms a reader might type. Matched, never shown. */
  keywords?: string
  /** Shown beside the result: a keybinding's keys. */
  detail?: string
}

type Rows = Array<
  string | [title: string, keywords: string] | [title: string, keywords: string, SettingsCapability]
>

/** A heading and the rows under it. `heading: null` for rows under the tab's own title. */
function section(
  tab: SettingsTab,
  heading: string | [title: string, keywords: string] | null,
  rows: Rows = [],
): SettingEntry[] {
  const [title, keywords] = typeof heading === 'string' ? [heading, undefined] : (heading ?? [])
  const entries: SettingEntry[] = title ? [{ tab, title, keywords }] : []
  for (const row of rows) {
    const [rowTitle, rowKeywords, requires] = typeof row === 'string' ? [row] : row
    entries.push({ tab, title: rowTitle, section: title, keywords: rowKeywords, requires })
  }
  return entries
}

/**
 * Every setting, in the order the tabs show them. Titles must match the
 * rendered text; `settingsQuery.test.ts` checks them against the tab sources
 * in both directions, so a renamed row fails CI rather than going unfindable.
 */
export const SETTINGS_INDEX: SettingEntry[] = [
  ...section('appearance', null, [
    ['Theme', 'dark light mode colour color system'],
    ['UI scale', 'zoom size interface', 'pageZoom'],
    ['Chat font size', 'text transcript'],
    ['Editor font size', 'monaco diff text'],
    ['Terminal font size', 'shell text', 'terminal'],
    ['Mono font', 'monospace typeface family code'],
  ]),
  ...section('writing', null, [
    ['Check spelling', 'spellcheck typo misspelled dictionary correct'],
    ['Autocomplete', 'suggestions predict next word ghost text complete'],
    ['Learned prompts', 'history clear forget autocomplete'],
  ]),
  ...section('agent', 'Agent defaults', [
    ['Scope', 'global project workspace override'],
    ['Default model', 'llm'],
    'Default provider',
    ['Default thinking level', 'reasoning effort'],
    ['Hide thinking blocks', 'reasoning collapse'],
    ['Steering delivery', 'queue steer'],
    ['Follow-up delivery', 'queue followup'],
  ]),
  ...section(
    'agent',
    ['Compaction', 'summarize context'],
    [
      ['Auto-compaction', 'summarize context window'],
      ['Reserve tokens', 'headroom response'],
      ['Keep recent tokens', 'verbatim'],
    ],
  ),
  ...section('agent', ['Context budget', 'window limit tokens compaction 200k']),
  ...section('agent', 'Auto-retry', [
    ['Retry on transient errors', 'overloaded rate limit 5xx'],
    ['Max retries', 'attempts'],
    ['Base delay (ms)', 'backoff'],
  ]),
  ...section(
    'agent',
    ['Directives', 'system prompt instructions'],
    [
      ['Worktree guard', 'branch checkout'],
      ['Machine awareness', 'host local remote tailscale machine prompt'],
      ['Lane charter', 'pull request pr'],
      ['Sub-agent policy', 'subagent delegation'],
    ],
  ),
  ...section('accounts', null, [
    ['Use a plan you already pay for', 'subscription sign in login oauth'],
    ['Billed per token', 'api key credit balance'],
  ]),
  ...section('extensions', null, [
    ['Recommended', 'packages catalogue'],
    ['Add a package', 'install npm git'],
  ]),
  ...section('claude-provider', null, [
    ['Health', 'claude cli version'],
    ['Prove it end to end', 'test check'],
    ['When it fails', 'troubleshoot error debug'],
    ['Accounts', 'claude login sign in'],
    ['Route new sessions', 'claude account'],
  ]),
  ...section('web-access', null, [['Search providers', 'web fetch api key']]),
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
  ...section('connectors', null, [
    ['Connected', 'mcp servers'],
    ['Add a connector', 'mcp server oauth url'],
    ['Config files', 'mcp.json'],
  ]),
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
  ...section('optimization', null, [
    ['Compress tool results', 'headroom proxy tokens'],
    ['Compress search & log output', 'headroom grep'],
  ]),
  ...section('optimization', ['Savings', 'tokens saved']),
  ...section('optimization', ['Advisor', 'recommendations findings']),
  ...section('voice', null, [
    ['Voice input', 'dictation dictate microphone mic speech to text transcribe'],
    ['Model', 'moonshine speech download'],
  ]),
  ...section('advanced', null, [
    ['pi health', 'version install'],
    ['pi settings.json', 'config edit raw'],
    ['pi models.json', 'custom providers local endpoints'],
  ]),
  ...section(
    'advanced',
    ['Maintenance', 'cleanup disk worktrees'],
    [
      ['Reclaim dead lanes', 'worktrees merged sweep'],
      ['Sweep every', 'interval'],
      'Leave lanes alone for',
      ['Delete automatically', 'remove'],
    ],
  ),
  ...section('advanced', ['Local pi resources', 'prompts themes extensions']),
  ...section('account', null, [
    ['Signed in', 'github user sign out log out'],
    ['Not signed in', 'github sign in login'],
  ]),
  ...section('install', null, [['Install', 'pwa home screen app']]),
  ...section('install', ['Notifications', 'push alerts inbox attention']),
  ...section('about', null, [
    ['Phosphor version', 'release', 'appInfo'],
    ['Updates', 'upgrade release download', 'appInfo'],
    ['pi version', 'pi health', 'appInfo'],
    ['Platform', 'os macos linux windows', 'appInfo'],
    ['Runtime', 'electron node chrome', 'appInfo'],
  ]),
  ...section('host-providers', ['Providers', 'Host sign in login claude codex openai']),
  ...section('host-connectors', ['Connectors', 'Host mcp servers']),
  ...section('host-agent', ['Agent defaults', 'Host default model thinking']),
  ...section('host-folders', ['Folders', 'Host repositories projects']),
  ...section('host-resources', ['Skills & extensions', 'Host packages']),
  ...section('host-advanced', ['Advanced', 'Host pi settings models json']),
  ...keybindingGroups().flatMap(({ title, bindings }) =>
    section('keybindings', title).concat(
      bindings.map<SettingEntry>(([parts, action]) => ({
        tab: 'keybindings',
        title: action,
        section: title,
        keywords: 'shortcut hotkey key',
        detail: formatShortcut(...parts),
      })),
    ),
  ),
]

/** The index rows this platform renders; sections are filtered by the caller's `available`. */
export function platformIndex(platform: Platform): SettingEntry[] {
  return SETTINGS_INDEX.filter((entry) => !entry.requires || platform[entry.requires])
}

/**
 * The tab to show when `tab` is not listed (another machine kind, a removed
 * package, a capability this platform lacks): its parent Extensions entry, the
 * same concern on the other machine, that machine's first section, then the first.
 */
export function resolveTab(tab: SettingsTab, listed: readonly SettingsSection[]): SettingsTab {
  const has = (id: SettingsTab | null): id is SettingsTab =>
    !!id && listed.some((section) => section.id === id)
  if (has(tab)) return tab
  if (EXTENSION_TABS.some((t) => t.id === tab) && has('extensions')) return 'extensions'
  const counterpart = counterpartTab(tab)
  if (has(counterpart)) return counterpart
  const machineScoped = [...TABS, ...EXTENSION_TABS].find((t) => t.id === tab)?.scope === 'machine'
  const firstMachine = listed.find((section) => section.scope === 'machine')
  return (machineScoped && firstMachine ? firstMachine : listed[0])?.id ?? 'appearance'
}
