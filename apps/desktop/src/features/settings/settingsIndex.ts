import type { PiPackageEntry } from '@shared/models'
import { formatShortcut } from '@/lib/shortcuts'
import type { SettingsTab } from './settingsUiStore'
import { keybindingGroups } from './tabs/KeybindingsTab'

export const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'agent', label: 'Agent' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'connectors', label: 'MCP Connectors' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'optimization', label: 'Optimization' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'keybindings', label: 'Keybindings' },
  { id: 'about', label: 'About' },
]

/**
 * Curated extensions contribute a tab only while their package is present.
 * They render nested under the Extensions entry in the sidebar — they are
 * configuration for an installed package, not top-level settings.
 */
export const EXTENSION_TABS: Array<{
  id: SettingsTab
  label: string
  packageMatch: string
  requiresInstalled?: boolean
}> = [
  { id: 'claude-provider', label: 'Claude Code', packageMatch: 'pi-claude-cli' },
  { id: 'web-access', label: 'Web access', packageMatch: 'pi-web-access' },
  { id: 'computer-use', label: 'Computer use', packageMatch: '@injaneity/pi-computer-use' },
  { id: 'subagents', label: 'Subagents', packageMatch: 'pi-subagents', requiresInstalled: true },
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

/** One searchable place in settings. */
export interface SettingEntry {
  tab: SettingsTab
  /** Exactly as the tab renders it: the result jumps to this text. */
  title: string
  /** The heading it sits under; unset for a heading itself. */
  section?: string
  /** Synonyms a reader might type. Matched, never shown. */
  keywords?: string
  /** Shown beside the result: a keybinding's keys. */
  detail?: string
}

type Rows = Array<string | [title: string, keywords: string]>

/** A heading and the rows under it. `heading: null` for rows under the tab's own title. */
function section(
  tab: SettingsTab,
  heading: string | [title: string, keywords: string] | null,
  rows: Rows = [],
): SettingEntry[] {
  const [title, keywords] = typeof heading === 'string' ? [heading, undefined] : (heading ?? [])
  const entries: SettingEntry[] = title ? [{ tab, title, keywords }] : []
  for (const row of rows) {
    const [rowTitle, rowKeywords] = typeof row === 'string' ? [row, undefined] : row
    entries.push({ tab, title: rowTitle, section: title, keywords: rowKeywords })
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
    ['UI scale', 'zoom size interface'],
    ['Chat font size', 'text transcript'],
    ['Editor font size', 'monaco diff text'],
    ['Terminal font size', 'shell text'],
    ['Mono font', 'monospace typeface family code'],
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
  ...section('about', null, [
    ['Phosphor version', 'release'],
    ['Updates', 'upgrade release download'],
    'pi version',
    ['Platform', 'os macos linux windows'],
    ['Runtime', 'electron node chrome'],
  ]),
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
