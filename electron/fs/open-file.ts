import { shell } from 'electron'
import { lstat } from 'node:fs/promises'
import { extensionOf } from '@shared/file-kinds'
import type { OpenInDefaultAppResult } from '@shared/models'

/**
 * Extensions whose "default app" RUNS them rather than showing them.
 *
 * `shell.openPath` is a double-click in Finder/Explorer: a `.command` opens
 * Terminal and executes, a `.js` on Windows goes to Windows Script Host, a
 * `.py` can go to Python Launcher. The Files pane offers "Open in default app"
 * for files it cannot render itself, and those files may have come from an
 * agent, a cloned repo or an email attachment — so a button that looks like
 * "view this" must never execute anything. Reveal in Finder stays available
 * for every one of these.
 */
const LAUNCHABLE = new Set([
  // macOS
  'app',
  'command',
  'tool',
  'terminal',
  'workflow',
  'action',
  'scpt',
  'scptd',
  'applescript',
  'pkg',
  'mpkg',
  'fileloc',
  'webloc',
  'inetloc',
  // Windows
  'exe',
  'com',
  'bat',
  'cmd',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'msc',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'reg',
  'url',
  'appref-ms',
  // cross-platform launchers and scripts
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'fish',
  'py',
  'pyw',
  'pl',
  'rb',
  'jar',
  'jnlp',
  'appimage',
  'run',
  'desktop',
])

/** Why a file may not be handed to the OS, or null when it may. Exported for tests. */
export function launchRefusal(
  path: string,
  info: { isFile: boolean; mode: number },
  platform: NodeJS.Platform = process.platform,
): OpenInDefaultAppResult | null {
  if (!info.isFile) return { ok: false, reason: 'not-a-file' }
  if (LAUNCHABLE.has(extensionOf(path))) return { ok: false, reason: 'launchable' }
  // An executable bit means `open` runs it (a Mach-O or script with no
  // extension goes straight to Terminal). Windows has no such bit.
  if (platform !== 'win32' && (info.mode & 0o111) !== 0) return { ok: false, reason: 'launchable' }
  return null
}

export async function openInDefaultApp(path: string): Promise<OpenInDefaultAppResult> {
  // lstat, not stat: a symlink is refused rather than followed to whatever
  // it points at, which is what the checks above would otherwise not see.
  const info = await lstat(path).catch(() => null)
  if (!info) return { ok: false, reason: 'not-a-file' }
  const refusal = launchRefusal(path, { isFile: info.isFile(), mode: info.mode })
  if (refusal) return refusal
  const error = await shell.openPath(path)
  return error ? { ok: false, reason: 'failed', message: error } : { ok: true }
}
