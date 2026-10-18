export interface DirEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
}

export interface FileContent {
  revision?: string | null
  path: string
  content: string
  size: number
  mtimeMs: number
  tooLarge?: boolean
  binary?: boolean
}

/**
 * `launchable`: the OS would RUN it (script, installer, executable bit), so
 * it is refused — see apps/desktop/electron/fs/open-file.ts.
 */
export type OpenInDefaultAppResult =
  | { ok: true }
  | { ok: false; reason: 'launchable' }
  | { ok: false; reason: 'not-a-file' }
  | { ok: false; reason: 'failed'; message: string }
