import type { SettingsCapability } from '../settingsIndex'
import type { SettingsTab } from '../settingsUiStore'

/** The machines that render a machine section's row. */
export interface RowMachines {
  local?: boolean
  host?: boolean
}

/** One searchable place in settings. */
export interface SettingEntry {
  tab: SettingsTab
  /**
   * Machine sections only: the machines that render this row. Unset, it is the
   * section's own (`local` and `host` in `TABS`), so a row of a view every
   * machine shares is found on every machine. Device rows ignore it.
   */
  on?: RowMachines
  /**
   * A scoped section's row that no folder renders: opening it switches the
   * scope line to Machine, so the reveal lands on it.
   */
  machineScope?: true
  /** A row the platform only renders with this capability. */
  requires?: SettingsCapability
  /** Exactly as the section renders it: the result jumps to this text. */
  title: string
  /** The heading it sits under; unset for a heading itself. */
  section?: string
  /** Synonyms a reader might type. Matched, never shown. */
  keywords?: string
  /** Shown beside the result: a keybinding's keys. */
  detail?: string
}

/** A row: its title, or its title and keywords, and optionally the capability it needs. */
export type SettingRows = Array<
  string | [title: string, keywords: string] | [title: string, keywords: string, SettingsCapability]
>

/**
 * Rows only This Mac renders in a view both machines share: its raw files,
 * maintenance, sandboxes and the Claude Code proof.
 */
export const LOCAL_ONLY: RowMachines = { local: true }

/**
 * A heading and the rows under it, in the order the section shows them.
 * `heading: null` for rows under the section's own title; `on` narrows them
 * to some machines (see `SettingEntry.on`).
 */
export function section(
  tab: SettingsTab,
  heading: string | [title: string, keywords: string] | null,
  rows: SettingRows = [],
  on?: RowMachines,
): SettingEntry[] {
  const [title, keywords] = typeof heading === 'string' ? [heading, undefined] : (heading ?? [])
  const machines = on ? { on } : {}
  const entries: SettingEntry[] = title ? [{ tab, ...machines, title, keywords }] : []
  for (const row of rows) {
    const [rowTitle, rowKeywords, requires] = typeof row === 'string' ? [row] : row
    entries.push({
      tab,
      ...machines,
      title: rowTitle,
      section: title,
      keywords: rowKeywords,
      requires,
    })
  }
  return entries
}
