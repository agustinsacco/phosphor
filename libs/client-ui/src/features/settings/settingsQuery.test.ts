import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_PLATFORM } from '@/platform/Platform'
import {
  EXTENSION_TABS,
  SETTINGS_INDEX,
  TABS,
  installedExtensionTabs,
  platformIndex,
  rowOnMachine,
  visibleSections,
} from './settingsIndex'
import { LOCAL_ONLY, type SettingEntry } from './search/settingEntry'
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

  it('never offers raw config editors a Host does not have (regression D5)', () => {
    const hostTabs = new Set(visibleSections(DESKTOP_PLATFORM, 'host').map((tab) => tab.id))
    const hostIndex = platformIndex(DESKTOP_PLATFORM, 'host')
    expect(searchSettings('models json', hostTabs, hostIndex)).toEqual([])
    expect(searchSettings('settings json', hostTabs, hostIndex)).toEqual([])
    const updates = searchSettings('host updates', hostTabs, hostIndex)
    expect(updates.map((group) => group.tab)).toEqual(['advanced'])
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

describe('rowOnMachine', () => {
  const row = (tab: SettingsTab, on?: SettingEntry['on']): SettingEntry => ({
    tab,
    title: 'Row',
    ...(on ? { on } : {}),
  })

  it("defaults a machine row to its section's machines", () => {
    // Agent and Folders are on both machines, Optimization on This Mac only.
    expect([rowOnMachine(row('agent'), 'local'), rowOnMachine(row('agent'), 'host')]).toEqual([
      true,
      true,
    ])
    expect(rowOnMachine(row('optimization'), 'host')).toBe(false)
    expect(rowOnMachine(row('folders'), 'local')).toBe(true)
    expect(rowOnMachine(row('subagents'), 'local')).toBe(true)
  })

  it('narrows a row to the machines it names', () => {
    expect(rowOnMachine(row('agent', LOCAL_ONLY), 'local')).toBe(true)
    expect(rowOnMachine(row('agent', LOCAL_ONLY), 'host')).toBe(false)
    expect(rowOnMachine(row('agent', { host: true }), 'local')).toBe(false)
  })

  it('keeps device rows everywhere and machine rows off when no machine is chosen', () => {
    expect(rowOnMachine(row('appearance', { host: true }), 'local')).toBe(true)
    expect(rowOnMachine(row('appearance'), null)).toBe(true)
    expect(rowOnMachine(row('agent'), null)).toBe(false)
  })

  it("indexes only This Mac's own Agent rows on This Mac, and only the heading on a Host", () => {
    const agent = (machine: 'local' | 'host'): string[] =>
      platformIndex(DESKTOP_PLATFORM, machine)
        .filter((entry) => entry.tab === 'agent' && !entry.section)
        .map((entry) => entry.title)
    expect(agent('local')).toContain('Context budget')
    expect(agent('host')).toEqual(['Agent defaults'])
  })
})

/**
 * The index is hand-written, so this keeps it honest against the section
 * sources in both directions: every literal row title and heading a section
 * renders is findable, and every indexed title is still rendered.
 */
describe('SETTINGS_INDEX against the section sources', () => {
  /** Scanned recursively for `.tsx` views, by path under features/settings. */
  const SCANNED = ['tabs', 'sections', 'components']
  /**
   * The section each scanned view renders. A file under `sections/<tab>/`
   * belongs to that tab unless it is listed here.
   */
  const FILE_TABS: Record<string, SettingsTab> = {
    'tabs/AboutTab.tsx': 'about',
    'tabs/AccountTab.tsx': 'account',
    'tabs/AccountsTab.tsx': 'accounts',
    'tabs/AdvancedTab.tsx': 'advanced',
    'tabs/AgentTab.tsx': 'agent',
    'tabs/AppearanceTab.tsx': 'appearance',
    'tabs/ClaudeAccountPanel.tsx': 'claude-provider',
    'tabs/ClaudeProviderTab.tsx': 'claude-provider',
    'tabs/ComputerUseTab.tsx': 'computer-use',
    'tabs/ConnectorsTab.tsx': 'connectors',
    'tabs/ContextBudgetSection.tsx': 'agent',
    'tabs/DirectivesSection.tsx': 'agent',
    'tabs/DirectiveToggles.tsx': 'agent',
    'tabs/ExtensionsTab.tsx': 'extensions',
    'tabs/InstallAppTab.tsx': 'install',
    'tabs/KeybindingsTab.tsx': 'keybindings',
    'tabs/MaintenanceSection.tsx': 'advanced',
    'tabs/OptimizationTab.tsx': 'optimization',
    'tabs/SubagentsTab.tsx': 'subagents',
    'tabs/VoiceTab.tsx': 'voice',
    'tabs/WebAccessTab.tsx': 'web-access',
    'tabs/WritingTab.tsx': 'writing',
  }
  /**
   * Files outside the scan whose titles a section renders: a shared row
   * component, or a data module (a field table) whose `title: '…'` entries the
   * section's view renders.
   */
  const SECTION_DATA: Partial<Record<SettingsTab, readonly string[]>> = {
    // Appearance renders these exact shared rows in Desktop and the browser.
    appearance: ['AppearancePreferences.tsx'],
  }

  const root = import.meta.dirname
  const tabIds = new Set<string>([...TABS, ...EXTENSION_TABS].map((t) => t.id))
  const read = (path: string): string =>
    readFileSync(resolve(root, path), 'utf8').replaceAll('&apos;', "'")
  const scanned = SCANNED.filter((dir) => existsSync(resolve(root, dir))).flatMap((dir) =>
    readdirSync(resolve(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))
      .map((file) => `${dir}/${file.split(sep).join('/')}`),
  )
  const tabOf = (path: string): SettingsTab | undefined => {
    const folder = /^sections\/([^/]+)\//.exec(path)?.[1]
    return FILE_TABS[path] ?? (folder && tabIds.has(folder) ? (folder as SettingsTab) : undefined)
  }
  const tabLabels = new Set([...TABS, ...EXTENSION_TABS].map((t) => t.label))
  const literals = (source: string, data: boolean): string[] =>
    [
      ...source.matchAll(/<Row\s+title="([^"]+)"/g),
      ...source.matchAll(/<SectionTitle(?:\s+small)?>\s*([^<{]+?)\s*<\/SectionTitle>/g),
      ...source.matchAll(/<h[34][^>]*>\s*([^<{]+?)\s*<\/h[34]>/g),
      ...(data ? source.matchAll(/\btitle:\s*(?:'([^']+)'|"([^"]+)")/g) : []),
    ]
      .map((match) => (match[1] ?? match[2]!).replace(/\s+/g, ' '))
      .filter((text) => !tabLabels.has(text))
  /** Every file a section renders from, with the titles it renders literally. */
  const sources = [
    ...scanned.map((path) => {
      const text = read(path)
      return { path, tab: tabOf(path), text, titles: literals(text, false) }
    }),
    ...Object.entries(SECTION_DATA).flatMap(([tab, paths]) =>
      paths.map((path) => {
        const text = read(path)
        return { path, tab: tab as SettingsTab, text, titles: literals(text, true) }
      }),
    ),
  ]
  /** The Host section headings, which the Host's own panels render. */
  const hostHeading = (entry: SettingEntry): boolean =>
    !!entry.on?.host && !entry.on.local && entry.section === undefined

  it('maps every source that renders a title to its section', () => {
    const unmapped = sources.filter((s) => s.titles.length > 0 && !s.tab).map((s) => s.path)
    expect(unmapped).toEqual([])
    const listed = [...Object.keys(FILE_TABS), ...Object.values(SECTION_DATA).flat()]
    expect(listed.filter((path) => !existsSync(resolve(root, path)))).toEqual([])
  })

  it('indexes every literal row title and heading', () => {
    const missing = sources.flatMap(({ path, tab, titles }) =>
      titles
        .filter((text) => !SETTINGS_INDEX.some((e) => e.tab === tab && text.startsWith(e.title)))
        .map((text) => `${path}: ${text}`),
    )
    expect(missing).toEqual([])
  })

  it('indexes only titles the sections still render', () => {
    const stale = SETTINGS_INDEX.filter((entry) => {
      if (entry.tab === 'keybindings' || hostHeading(entry)) return false
      return !sources.some((s) => s.tab === entry.tab && s.text.includes(entry.title))
    }).map((entry) => `${entry.tab}: ${entry.title}`)
    expect(stale).toEqual([])
  })

  it('indexes each Host section by the heading its panel renders', () => {
    const machines = resolve(root, '../machines')
    const panels = readdirSync(machines)
      .filter((f) => /^(Machine\w+Settings|HostConnectorSections)\.tsx$/.test(f))
      .map((f) => readFileSync(resolve(machines, f), 'utf8'))
      .join('\n')
    const hostEntries = SETTINGS_INDEX.filter(hostHeading)
    // Folders renders one shared view on every machine, so it has no Host heading.
    expect(hostEntries.map((entry) => entry.tab)).toEqual(
      TABS.filter((tab) => tab.host && tab.id !== 'folders').map((tab) => tab.id),
    )
    for (const entry of hostEntries)
      expect(panels, entry.title).toContain(`font-semibold">${entry.title}</h2>`)
  })

  it('has unique titles within each section on each machine', () => {
    const keys = SETTINGS_INDEX.map(
      (e) =>
        `${rowOnMachine(e, 'local')}/${rowOnMachine(e, 'host')}/${e.tab}/${e.section}/${e.title}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})
