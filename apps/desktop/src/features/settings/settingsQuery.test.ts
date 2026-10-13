import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTENSION_TABS, SETTINGS_INDEX, TABS, installedExtensionTabs } from './settingsIndex'
import { highlightPattern, searchSettings } from './settingsQuery'
import type { SettingsTab } from './settingsUiStore'

const ALL = new Set<SettingsTab>([...TABS, ...EXTENSION_TABS].map((t) => t.id))
const titles = (query: string, available = ALL): string[] =>
  searchSettings(query, available).flatMap((group) => group.entries.map((e) => e.title))

describe('searchSettings', () => {
  it('puts the best title match first', () => {
    expect(titles('theme')[0]).toBe('Theme')
    expect(titles('max retries')[0]).toBe('Max retries')
  })

  it('ANDs words across title, section, tab and keywords', () => {
    expect(titles('font size')).toEqual([
      'Chat font size',
      'Editor font size',
      'Terminal font size',
    ])
    expect(titles('dark mode')).toEqual(['Theme'])
    expect(titles('appearance terminal')).toEqual(['Terminal font size'])
  })

  it('ignores separators and excludes negated words', () => {
    expect(titles('autocompaction')).toContain('Auto-compaction')
    expect(titles('font size -terminal -editor')).toEqual(['Chat font size'])
  })

  it('groups by tab, best group first, and skips tabs that are not shown', () => {
    const groups = searchSettings('accounts', ALL)
    expect(groups.map((g) => g.tab)).toEqual(['claude-provider', 'accounts'])
    const withoutClaude = new Set([...ALL].filter((tab) => tab !== 'claude-provider'))
    expect(searchSettings('accounts', withoutClaude).map((g) => g.tab)).toEqual(['accounts'])
  })

  it('indexes keybindings with their keys', () => {
    const [group] = searchSettings('command palette', ALL)
    expect(group?.tab).toBe('keybindings')
    expect(group?.entries[0]).toMatchObject({ title: 'Command palette', section: 'App' })
    expect(group?.entries[0]?.detail).toBeTruthy()
  })

  it('only finds subagent settings while the package is installed', () => {
    const absent = new Set([...TABS, ...installedExtensionTabs([])].map((tab) => tab.id))
    expect(searchSettings('forked context', absent)).toEqual([])
    expect(titles('subagents permissions')).toEqual(['Context and permissions'])
    const pkg = { spec: 'npm:pi-subagents', installed: false } as Parameters<
      typeof installedExtensionTabs
    >[0][number]
    expect(installedExtensionTabs([pkg])).toEqual([])
    expect(
      installedExtensionTabs([{ ...pkg, spec: 'npm:@saccolabs/pi-claude-cli' }]).map(
        (tab) => tab.id,
      ),
    ).toEqual(['claude-provider'])
    expect(installedExtensionTabs([{ ...pkg, installed: true }]).map((tab) => tab.id)).toEqual([
      'subagents',
    ])
  })

  it('finds nothing for an empty or all-negated query', () => {
    expect(searchSettings('', ALL)).toEqual([])
    expect(searchSettings('-theme', ALL)).toEqual([])
    expect(searchSettings('zzzz', ALL)).toEqual([])
  })
})

describe('highlightPattern', () => {
  it('matches each term and its parts, longest first', () => {
    const pattern = highlightPattern('auto-compaction size')!
    expect('Auto-compaction and size'.match(pattern)).toEqual(['Auto-compaction', 'size'])
    expect('auto off'.match(pattern)).toEqual(['auto'])
  })

  it('is null without a highlightable term', () => {
    expect(highlightPattern('  ')).toBeNull()
    expect(highlightPattern('-theme')).toBeNull()
  })
})

/**
 * The index is hand-written, so this keeps it honest against the tab sources
 * in both directions: every literal row title and heading a tab renders is
 * findable, and every indexed title is still rendered.
 */
describe('SETTINGS_INDEX against the tab sources', () => {
  const FILE_TABS: Record<string, SettingsTab> = {
    AboutTab: 'about',
    AccountsTab: 'accounts',
    AdvancedTab: 'advanced',
    AgentTab: 'agent',
    AppearanceTab: 'appearance',
    ClaudeAccountPanel: 'claude-provider',
    ClaudeProviderTab: 'claude-provider',
    ComputerUseTab: 'computer-use',
    ConnectorsTab: 'connectors',
    ContextBudgetSection: 'agent',
    DirectivesSection: 'agent',
    ExtensionsTab: 'extensions',
    KeybindingsTab: 'keybindings',
    MaintenanceSection: 'advanced',
    OptimizationTab: 'optimization',
    SubagentsTab: 'subagents',
    WebAccessTab: 'web-access',
    WorkspacesTab: 'workspaces',
  }
  const dir = resolve(import.meta.dirname, 'tabs')
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  const sources = new Map(
    files.map((f) => [
      f.replace('.tsx', ''),
      readFileSync(resolve(dir, f), 'utf8').replaceAll('&apos;', "'"),
    ]),
  )
  const tabLabels = new Set([...TABS, ...EXTENSION_TABS].map((t) => t.label))
  const literals = (source: string): string[] =>
    [
      ...source.matchAll(/<Row\s+title="([^"]+)"/g),
      ...source.matchAll(/<SectionTitle(?:\s+small)?>\s*([^<{]+?)\s*<\/SectionTitle>/g),
      ...source.matchAll(/<h[34][^>]*>\s*([^<{]+?)\s*<\/h[34]>/g),
    ]
      .map((match) => match[1]!.replace(/\s+/g, ' '))
      .filter((text) => !tabLabels.has(text))

  it('maps every tab source file to its tab', () => {
    expect(Object.keys(FILE_TABS).sort()).toEqual([...sources.keys()].sort())
  })

  it('indexes every literal row title and heading', () => {
    const missing = [...sources].flatMap(([file, source]) =>
      literals(source)
        .filter(
          (text) =>
            !SETTINGS_INDEX.some((e) => e.tab === FILE_TABS[file] && text.startsWith(e.title)),
        )
        .map((text) => `${file}: ${text}`),
    )
    expect(missing).toEqual([])
  })

  it('indexes only titles the tabs still render', () => {
    const stale = SETTINGS_INDEX.filter((entry) => {
      if (entry.tab === 'keybindings') return false
      const files = Object.keys(FILE_TABS).filter((file) => FILE_TABS[file] === entry.tab)
      return !files.some((file) => sources.get(file)?.includes(entry.title))
    }).map((entry) => `${entry.tab}: ${entry.title}`)
    expect(stale).toEqual([])
  })

  it('has unique titles within each section', () => {
    const keys = SETTINGS_INDEX.map((e) => `${e.tab}/${e.section}/${e.title}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
