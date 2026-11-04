import type { PiPackageEntry } from '@shared/models'
import type { Platform } from '@/platform/Platform'
import type { MachineSettingsTab } from './machine/HostSection'
import type { SettingsTab } from './settingsUiStore'
import type { SettingEntry } from './search/settingEntry'
import { ACCOUNTS_ROWS } from './search/rows/accounts'
import { ADVANCED_ROWS } from './search/rows/advanced'
import { AGENT_ROWS } from './search/rows/agent'
import { CONNECTORS_ROWS } from './search/rows/connectors'
import {
  ABOUT_ROWS,
  ACCOUNT_ROWS,
  APPEARANCE_ROWS,
  INSTALL_ROWS,
  KEYBINDING_ROWS,
  WRITING_ROWS,
} from './search/rows/device'
import {
  CLAUDE_PROVIDER_ROWS,
  EXTENSIONS_ROWS,
  SUBAGENTS_ROWS,
  WEB_ACCESS_ROWS,
} from './search/rows/extensions'
import { FOLDERS_ROWS } from './search/rows/folders'
import { LANES_ROWS } from './search/rows/lanes'
import { OPTIMIZATION_ROWS } from './search/rows/optimization'
import { VOICE_ROWS } from './search/rows/voice'

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
  device('lanes', 'Lanes'),
  device('voice', 'Voice', ['localVoice']),
  device('keybindings', 'Keybindings', ['appShortcuts']),
  device('account', 'Phosphor account'),
  device('install', 'App installation', ['installableApp']),
  device('about', 'About'),
  machineSection('agent', 'Agent', { local: true, host: 'agent' }),
  machineSection('accounts', 'Accounts', { local: true, host: 'providers' }),
  machineSection('extensions', 'Extensions', { local: true, host: 'resources' }),
  machineSection('connectors', 'MCP Connectors', { local: true, host: 'connectors' }),
  machineSection('folders', 'Folders', { local: true, host: 'connection' }),
  machineSection('optimization', 'Optimization', { local: true }),
  machineSection('advanced', 'Advanced', { local: true, host: 'advanced' }),
]

/**
 * Curated extensions contribute a tab only while their package is present.
 * They render nested under the Extensions entry in the sidebar — they are
 * configuration for an installed package, not top-level settings.
 */
export const EXTENSION_TABS: Array<
  SettingsSection & {
    packageMatch: string
    requiresInstalled?: boolean
    /** Listed on every machine that has a view for it, installed or not: its page offers Install. */
    always?: true
  }
> = [
  {
    ...machineSection('claude-provider', 'Claude Code', { local: true, host: 'providers' }),
    packageMatch: 'pi-claude-cli',
    always: true,
  },
  {
    ...machineSection('web-access', 'Web access', { local: true, host: 'resources' }),
    packageMatch: 'pi-web-access',
  },
  {
    ...machineSection('computer-use', 'Computer use', { local: true, host: 'resources' }),
    packageMatch: '@injaneity/pi-computer-use',
  },
  {
    ...machineSection('subagents', 'Subagents', { local: true, host: 'resources' }),
    packageMatch: 'pi-subagents',
    requiresInstalled: true,
  },
]

export function installedExtensionTabs(
  entries: readonly Pick<PiPackageEntry, 'spec' | 'installed'>[],
): typeof EXTENSION_TABS {
  return EXTENSION_TABS.filter(
    (tab) =>
      tab.always === true ||
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

/**
 * Every setting, in the order the sections show them. Each section's rows live
 * in its own module under `search/rows/`. Titles must match the rendered text;
 * `settingsQuery.test.ts` checks them against the section sources in both
 * directions, so a renamed row fails CI rather than going unfindable.
 */
export const SETTINGS_INDEX: SettingEntry[] = [
  ...APPEARANCE_ROWS,
  ...WRITING_ROWS,
  ...LANES_ROWS,
  ...VOICE_ROWS,
  ...AGENT_ROWS,
  ...ACCOUNTS_ROWS,
  ...EXTENSIONS_ROWS,
  ...CLAUDE_PROVIDER_ROWS,
  ...WEB_ACCESS_ROWS,
  ...SUBAGENTS_ROWS,
  ...CONNECTORS_ROWS,
  ...FOLDERS_ROWS,
  ...OPTIMIZATION_ROWS,
  ...ADVANCED_ROWS,
  ...ACCOUNT_ROWS,
  ...INSTALL_ROWS,
  ...ABOUT_ROWS,
  ...KEYBINDING_ROWS,
]

/**
 * Whether this kind of machine renders the row: its own `on`, else its
 * section's flags. Device rows render whatever the machine, machine rows on none
 * while no machine is chosen.
 */
export function rowOnMachine(entry: SettingEntry, machine: MachineKind | null): boolean {
  const owner = findSection(entry.tab)
  if (owner?.scope !== 'machine') return true
  if (!machine) return false
  return entry.on ? entry.on[machine] === true : onMachine(owner, machine)
}

/**
 * The index rows this platform renders on this kind of machine; sections are
 * filtered by the caller's `available`.
 */
export function platformIndex(platform: Platform, machine: MachineKind | null): SettingEntry[] {
  return SETTINGS_INDEX.filter(
    (entry) => (!entry.requires || platform[entry.requires]) && rowOnMachine(entry, machine),
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
