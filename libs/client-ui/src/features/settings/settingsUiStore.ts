import { create } from 'zustand'
import type { MachineSettingsTab } from '@/features/machines/MachineSettings'

/** A Host machine settings section, rendered for a Host chosen in Settings. */
export type HostSettingsTab = `host-${MachineSettingsTab}`

export type SettingsTab =
  | 'appearance'
  | 'writing'
  | 'agent'
  | 'accounts'
  | 'extensions'
  | 'claude-provider'
  | 'web-access'
  | 'computer-use'
  | 'subagents'
  | 'connectors'
  | 'workspaces'
  | 'optimization'
  | 'voice'
  | 'advanced'
  | 'keybindings'
  | 'account'
  | 'install'
  | 'about'
  | HostSettingsTab

/** The machine Settings configures: This Mac or a Host id. */
export type SettingsMachine = 'local' | (string & {})

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
  /** Chosen in the Configure selector; null follows the default (see useSettingsMachine). */
  machine: SettingsMachine | null
  /** The search field. Its terms are painted in the open tab while set. */
  query: string
  /** Results are listed in place of the tab; false once one is opened or a tab is picked. */
  listing: boolean
  /** A setting to scroll to and flash once its tab renders; a new object per request. */
  reveal: { title: string } | null
  setOpen: (open: boolean) => void
  /** A fresh visit: default machine, no search. The browser page calls it on arrival. */
  reset: () => void
  setTab: (tab: SettingsTab) => void
  setMachine: (machine: SettingsMachine) => void
  setQuery: (query: string) => void
  openResult: (tab: SettingsTab, title: string) => void
}

const FRESH = { machine: null, query: '', listing: false, reveal: null } as const

/**
 * Open/close state for the settings modal, and the shared surface's selection.
 *
 * Deliberately a separate module from `SettingsModal.tsx`: the command palette
 * and the global keyboard shortcuts only need to *open* settings, and importing
 * the component would drag Monaco (via the config-file editor) into their
 * bundles.
 */
export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  open: false,
  tab: 'appearance',
  ...FRESH,
  // Each opening starts unsearched on the default machine; ⌘, while already open keeps both.
  setOpen: (open) => set((s) => (s.open === open ? {} : { open, ...FRESH })),
  reset: () => set(FRESH),
  setTab: (tab) => set({ tab, listing: false, reveal: null }),
  setMachine: (machine) => set({ machine, reveal: null }),
  setQuery: (query) => set({ query, listing: query.trim() !== '' }),
  openResult: (tab, title) => set({ tab, listing: false, reveal: { title } }),
}))
