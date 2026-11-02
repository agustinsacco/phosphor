import type { SettingsNoticeProps } from '@/components/form'
import type { WebAccessKey } from '@shared/web-access'

/** pi-web-access's `web-search.json` on one machine: which keys are set, by name only. */
export interface WebAccessSource {
  caps: {
    /** The raw file can be opened here, and shows the key values: This Mac only. */
    rawEditor: boolean
  }
  /** Null while the first read is in flight, or when the machine cannot report it. */
  configured: readonly WebAccessKey[] | null
  /** The file is not valid JSON: fields are read-only so a save cannot clobber it. */
  malformed: boolean
  /** Where the file is, when the machine says. */
  path: string | null
  /** The one notice above the fields: a failed read, or a Host too old to report keys. */
  notice: SettingsNoticeProps | null
  busy: boolean
  /** Set a key's value, or clear it with null. */
  set(key: WebAccessKey, value: string | null): void
  /** The raw file was edited elsewhere: read it again. */
  refresh(): void
}
