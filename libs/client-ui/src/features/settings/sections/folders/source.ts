import type { SettingsNoticeProps } from '@/components/form'

/** A folder a machine runs lanes in: a recent workspace on This Mac, a registered folder on a Host. */
export interface FolderItem {
  /** The workspace path on This Mac, the repository id on a Host. */
  id: string
  name: string
  path: string
}

/** What a machine lets Folders do. */
export interface FolderCaps {
  /** Folders can be added here (This Mac's picker, or browsing the Host). */
  add: boolean
  /** How a folder leaves the list: forgotten (This Mac) or unregistered (a Host); null when it cannot. */
  remove: 'forget' | 'unregister' | null
  /** A folder's pi project trust can be reviewed here. */
  trustReview: boolean
  /** This machine has "No folder" sandboxes. */
  sandboxes: boolean
}

/** One machine's folders for the shared Folders view. */
export interface FolderSource {
  /** One line under the title saying what the list is. */
  intro: string
  /** A failed action, or why the folders cannot be changed. */
  notice: SettingsNoticeProps | null
  caps: FolderCaps
  folders: readonly FolderItem[]
  /** An action is in flight: buttons wait for it. */
  busy: boolean
  add: () => void
  /** The Host's folder browser while it is open. */
  addDialog?: React.ReactNode
  remove: (folder: FolderItem) => Promise<void>
  reviewTrust: (folder: FolderItem) => void
}
