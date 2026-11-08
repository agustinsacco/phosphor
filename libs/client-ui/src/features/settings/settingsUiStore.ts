import { create } from 'zustand'

/** A section id. A concern both kinds of machine have keeps one id on both. */
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
  | 'lanes'
  | 'folders'
  | 'optimization'
  | 'voice'
  | 'brain'
  | 'advanced'
  | 'keybindings'
  | 'account'
  | 'install'
  | 'about'

/** The machine Settings configures: This Mac or a Host id. */
export type SettingsMachine = 'local' | (string & {})

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
  /** Chosen in the Configure selector; null follows the default (see useSettingsMachine). */
  machine: SettingsMachine | null
  /**
   * The folder a scoped section configures; null is the whole machine. A
   * workspace path on This Mac, a repository id on a Host.
   */
  folder: string | null
  /** The search field. Its terms are painted in the open tab while set. */
  query: string
  /** Results are listed in place of the tab; false once one is opened or a tab is picked. */
  listing: boolean
  /** A setting to scroll to and flash once its tab renders; a new object per request. */
  reveal: { title: string } | null
  /** Counts This Mac's scope-line Refreshes; its sections read again on each. */
  rereads: number
  setOpen: (open: boolean) => void
  /** A fresh visit: default machine, no search. The browser page calls it on arrival. */
  reset: () => void
  setTab: (tab: SettingsTab) => void
  setMachine: (machine: SettingsMachine) => void
  setFolder: (folder: string | null) => void
  setQuery: (query: string) => void
  openResult: (tab: SettingsTab, title: string) => void
  reread: () => void
}

const FRESH = { machine: null, folder: null, query: '', listing: false, reveal: null } as const

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
  rereads: 0,
  ...FRESH,
  // Each opening starts unsearched on the default machine; ⌘, while already open keeps both.
  setOpen: (open) => set((s) => (s.open === open ? {} : { open, ...FRESH })),
  reset: () => set(FRESH),
  setTab: (tab) => set({ tab, listing: false, reveal: null }),
  // A folder belongs to one machine: another machine starts on its machine scope.
  setMachine: (machine) =>
    set((s) =>
      s.machine === machine ? { reveal: null } : { machine, folder: null, reveal: null },
    ),
  setFolder: (folder) => set({ folder }),
  setQuery: (query) => set({ query, listing: query.trim() !== '' }),
  openResult: (tab, title) => set({ tab, listing: false, reveal: { title } }),
  reread: () => set((s) => ({ rereads: s.rereads + 1 })),
}))
