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
 * Rows only This Mac renders, in a section a Host also has. A section's rows
 * drop this once a view both machines share renders them.
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

/** A Host section, findable by the heading its Host panel renders. */
export const onHost = (
  tab: SettingsTab,
  heading: [title: string, keywords: string],
): SettingEntry[] => section(tab, heading, [], { host: true })
