import type { PiPackageEntry } from '@shared/models'
import { formatShortcut } from '@/lib/shortcuts'
import type { Platform } from '@/platform/Platform'
import type { MachineSettingsTab } from './machine/HostSection'
import type { SettingsTab } from './settingsUiStore'
import { keybindingGroups } from './tabs/KeybindingsTab'

/** A Platform flag a section or row needs. Never the form factor. */
export type SettingsCapability = Exclude<keyof Platform, 'formFactor'>

/** The kinds of machine Configure can choose. */
export type MachineKind = 'local' | 'host'

/** What the platform needs before it lists any of that kind of machine's sections. */
const MACHINE_REQUIRES: Record<MachineKind, readonly SettingsCapability[]> = {
  local: ['localLanes'],
  host: ['machineSettings'],
}

/** One entry in the Settings section navigation. */
export interface SettingsSection {
  id: SettingsTab
  label: string
  /** Device sections configure this client; machine sections the machine chosen in Configure. */
  scope: 'device' | 'machine'
  /** Machine sections: This Mac has this concern. */
  local?: boolean
  /** Machine sections: Hosts have this concern, under this Host settings section. */
  host?: MachineSettingsTab
  /** Device sections: the capabilities this platform needs to list it. */
  requires: readonly SettingsCapability[]
}

const device = (
  id: SettingsTab,
  label: string,
  requires: SettingsCapability[] = [],
): SettingsSection => ({ id, label, scope: 'device', requires })
/** One concern on every machine that has it: the same id, label and place for each. */
const machineSection = (
  id: SettingsTab,
  label: string,
  on: { local?: true; host?: MachineSettingsTab },
): SettingsSection => ({ id, label, scope: 'machine', ...on, requires: [] })

/** Every top-level section, device sections first, in navigation order. */
export const TABS: SettingsSection[] = [
  device('appearance', 'Appearance'),
  device('writing', 'Writing', ['writingAssist']),
  device('keybindings', 'Keybindings', ['appShortcuts']),
  device('account', 'Phosphor account'),
  device('install', 'App installation', ['installableApp']),
  device('about', 'About'),
  machineSection('agent', 'Agent', { local: true, host: 'agent' }),
  machineSection('accounts', 'Accounts', { local: true, host: 'providers' }),
  machineSection('extensions', 'Extensions', { local: true, host: 'resources' }),
  machineSection('connectors', 'MCP Connectors', { local: true, host: 'connectors' }),
  machineSection('workspaces', 'Workspaces', { local: true }),
  machineSection('folders', 'Folders', { host: 'folders' }),
  machineSection('optimization', 'Optimization', { local: true }),
  machineSection('voice', 'Voice', { local: true }),
  machineSection('advanced', 'Advanced', { local: true, host: 'advanced' }),
]

/**
 * Curated extensions contribute a tab only while their package is present.
 * They render nested under the Extensions entry in the sidebar — they are
 * configuration for an installed package, not top-level settings.
 */
export const EXTENSION_TABS: Array<
  SettingsSection & { packageMatch: string; requiresInstalled?: boolean }
> = [
  {
    ...machineSection('claude-provider', 'Claude Code', { local: true }),
    packageMatch: 'pi-claude-cli',
  },
  { ...machineSection('web-access', 'Web access', { local: true }), packageMatch: 'pi-web-access' },
  {
    ...machineSection('computer-use', 'Computer use', { local: true }),
    packageMatch: '@injaneity/pi-computer-use',
  },
  {
    ...machineSection('subagents', 'Subagents', { local: true }),
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

/** The section with this id, top-level or an extension tab. */
export const findSection = (id: SettingsTab): SettingsSection | undefined =>
  [...TABS, ...EXTENSION_TABS].find((t) => t.id === id)

export const tabLabel = (id: SettingsTab): string => findSection(id)?.label ?? id

export const supports = (platform: Platform, requires: readonly SettingsCapability[]): boolean =>
  requires.every((capability) => platform[capability])

/** Whether this kind of machine has this section. */
export const onMachine = (section: SettingsSection, kind: MachineKind): boolean =>
  kind === 'local' ? section.local === true : section.host !== undefined

/**
 * The top-level sections this platform lists for the chosen machine kind: every
 * supported device section, then that machine's sections. Search uses the same set.
 */
export function visibleSections(
  platform: Platform,
  machine: MachineKind | null,
): SettingsSection[] {
  return TABS.filter((tab) =>
    tab.scope === 'device'
      ? supports(platform, tab.requires)
      : !!machine && onMachine(tab, machine) && supports(platform, MACHINE_REQUIRES[machine]),
  )
}

/** One searchable place in settings. */
export interface SettingEntry {
  tab: SettingsTab
  /** Rendered on this kind of machine only; unset for device rows. */
  machine?: MachineKind
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

/**
 * A heading and the rows under it. `heading: null` for rows under the tab's own
 * title. A machine section's rows are This Mac's own until its view is shared.
 */
function section(
  tab: SettingsTab,
  heading: string | [title: string, keywords: string] | null,
  rows: Rows = [],
  machine: MachineKind | undefined = findSection(tab)?.scope === 'machine' ? 'local' : undefined,
): SettingEntry[] {
  const [title, keywords] = typeof heading === 'string' ? [heading, undefined] : (heading ?? [])
  const entries: SettingEntry[] = title ? [{ tab, machine, title, keywords }] : []
  for (const row of rows) {
    const [rowTitle, rowKeywords, requires] = typeof row === 'string' ? [row] : row
    entries.push({ tab, machine, title: rowTitle, section: title, keywords: rowKeywords, requires })
  }
  return entries
}

/** A Host section, findable by the heading its panel renders. */
const onHost = (tab: SettingsTab, heading: [title: string, keywords: string]): SettingEntry[] =>
  section(tab, heading, [], 'host')

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
      ['Global instructions', 'agents.md claude.md custom rules prompt edit markdown'],
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
  ...section('install', ['Notifications', 'push alerts attention']),
  ...section('about', null, [
    ['Phosphor version', 'release', 'appInfo'],
    ['Updates', 'upgrade release download', 'appInfo'],
    ['pi version', 'pi health', 'appInfo'],
    ['Platform', 'os macos linux windows', 'appInfo'],
    ['Runtime', 'electron node chrome', 'appInfo'],
  ]),
  ...onHost('agent', ['Agent defaults', 'Host default model thinking']),
  ...onHost('accounts', ['Accounts', 'Host providers sign in login claude codex openai']),
  ...onHost('extensions', ['Extensions', 'Host skills packages']),
  ...onHost('connectors', ['MCP Connectors', 'Host mcp servers']),
  ...onHost('folders', ['Folders', 'Host repositories projects']),
  ...onHost('advanced', ['Advanced', 'Host pi settings models json']),
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

/**
 * The index rows this platform renders on this kind of machine; sections are
 * filtered by the caller's `available`.
 */
export function platformIndex(platform: Platform, machine: MachineKind | null): SettingEntry[] {
  return SETTINGS_INDEX.filter(
    (entry) =>
      (!entry.requires || platform[entry.requires]) &&
      (!entry.machine || entry.machine === machine),
  )
}

/**
 * The tab to show when `tab` is not listed (another machine kind, a removed
 * package, a capability this platform lacks): its parent Extensions entry, the
 * machine's first section, then the first. Every machine names a shared concern
 * by the same id, so switching machines keeps it open without a lookup.
 */
export function resolveTab(tab: SettingsTab, listed: readonly SettingsSection[]): SettingsTab {
  const has = (id: SettingsTab): boolean => listed.some((section) => section.id === id)
  if (has(tab)) return tab
  if (EXTENSION_TABS.some((t) => t.id === tab) && has('extensions')) return 'extensions'
  const firstMachine = listed.find((section) => section.scope === 'machine')
  return (
    (findSection(tab)?.scope === 'machine' && firstMachine ? firstMachine : listed[0])?.id ??
    'appearance'
  )
}
