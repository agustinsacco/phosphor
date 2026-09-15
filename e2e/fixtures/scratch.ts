import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A temp directory, resolved.
 *
 * The resolution is the whole point. macOS hands out `/var/folders/…` and
 * `/var` is a symlink to `/private/var`, so a raw temp path is a SECOND
 * spelling of the directory it names. Phosphor resolves a workspace path when
 * it records one (electron/store.ts) — one folder, one spelling, one sidebar
 * group — so a test holding the unresolved form would compare its own path
 * against the app's resolved one and fail on macOS while passing on Linux.
 */
export async function scratchDir(prefix: string): Promise<string> {
  return realpathSync.native(await mkdtemp(join(tmpdir(), prefix)))
}

/** `scratchDir` for module-scope setup, which cannot await. */
export function scratchDirSync(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}
