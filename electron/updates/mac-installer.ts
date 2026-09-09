import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Self-update for macOS builds that cannot use `electron-updater`.
 *
 * `MacUpdater` hands the download to Squirrel.Mac, which validates the new
 * bundle against the RUNNING app's designated requirement. Phosphor ships ad-hoc
 * signed (no Developer ID), and an ad-hoc requirement is a per-build `cdhash`,
 * so that validation can never pass. Turning `phosphorSigned` on for macOS would trade "opens a browser" for
 * "errors silently".
 *
 * So this module does by hand what `scripts/install.sh` does by shell: fetch
 * the arch-matched zip named in `latest-mac.yml`, verify its sha512, expand it,
 * verify the resulting bundle, then swap it into place and relaunch.
 *
 * Two rules hold everything else up:
 *
 *  1. **Every path is derived, never interpolated from the network.** The
 *     manifest supplies a version string and a file name used only to build a
 *     GitHub download URL; the install destination comes from `app.getPath`.
 *  2. **The swap is two renames on one volume.** Staging lives beside the
 *     installed bundle rather than in `/tmp`, so the moment of replacement is
 *     atomic and reversible instead of a multi-second copy that can half-fail.
 */

/** Staging and backup directories, both siblings of the installed bundle. */
const STAGING_PREFIX = '.phosphor-update-'
const BACKUP_PREFIX = '.phosphor-old-'

/**
 * Names the startup sweep is allowed to delete.
 *
 * Deliberately exact: this matches only what {@link stagingDirName} and
 * {@link backupDirName} produce. A prefix test alone would let a
 * `.phosphor-old-notes` a user happened to create fall inside `rm -rf`.
 */
// `.pidex-` is matched too: the release that renamed the app to Phosphor is
// downloaded and staged BY the last pidex build, whose staging/backup dirs
// use the old prefix — and only the new build's sweep runs after the swap.
const ORPHAN_RE = /^\.(?:phosphor|pidex)-(?:update|old)-\d+-\d+(?:\.app)?$/

export interface MacManifestFile {
  url: string
  sha512: string
  size: number
}

export interface MacManifest {
  version: string
  files: MacManifestFile[]
}

/**
 * Parse `latest-mac.yml` without a YAML dependency.
 *
 * The manifest is a fixed two-level shape electron-builder generates, so a
 * line reader is enough — but it MUST distinguish the per-file `sha512:` from
 * the top-level one that follows the list, or every file inherits the last
 * value. Indentation is the only signal, so it is the one this leans on: a
 * key at column 0 ends the `files:` block.
 */
export function parseMacManifest(body: string): MacManifest | null {
  let version = ''
  const files: MacManifestFile[] = []
  let inFiles = false
  let current: Partial<MacManifestFile> | null = null

  const flush = (): void => {
    if (current?.url && current.sha512) {
      files.push({ url: current.url, sha512: current.sha512, size: Number(current.size ?? 0) })
    }
    current = null
  }

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue

    // A key at column 0 closes any list that was open.
    if (!/^\s/.test(line)) {
      flush()
      inFiles = false
      const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (!top) continue
      if (top[1] === 'version') version = unquote(top[2] ?? '')
      else if (top[1] === 'files') inFiles = true
      continue
    }
    if (!inFiles) continue

    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item) {
      flush()
      current = {}
      applyField(current, item[1] ?? '')
      continue
    }
    if (current) applyField(current, line.trim())
  }
  flush()

  if (!version || files.length === 0) return null
  return { version, files }
}

function applyField(target: Partial<MacManifestFile>, text: string): void {
  const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(text)
  if (!field) return
  const value = unquote(field[2] ?? '')
  if (field[1] === 'url') target.url = value
  else if (field[1] === 'sha512') target.sha512 = value
  else if (field[1] === 'size') target.size = Number(value)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && /^(['"]).*\1$/.test(trimmed)) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * The zip built for this machine.
 *
 * electron-builder names the Intel zip `-mac.zip` and the Apple-silicon one
 * `-arm64-mac.zip`, so "does it contain -arm64-" is the whole test — but the
 * x64 match has to EXCLUDE that substring, otherwise an arm64 Mac handed the
 * first matching entry gets the Intel build (the manifest lists x64 first, and
 * its top-level `path:` points there too).
 */
export function pickMacZip(files: MacManifestFile[], arch: string): MacManifestFile | null {
  const zips = files.filter((file) => file.url.endsWith('.zip'))
  const arm = zips.find((file) => file.url.includes('-arm64-mac.'))
  if (arch === 'arm64') return arm ?? null
  return zips.find((file) => !file.url.includes('-arm64-')) ?? null
}

/**
 * The `.app` root containing a given executable path.
 *
 * `app.getPath('exe')` is `<bundle>/Contents/MacOS/<name>`, so the bundle is
 * three levels up. Returns null for anything that is not that shape — an
 * unpackaged dev run, most obviously, which must never reach the swap.
 */
export function bundlePathFromExe(exePath: string): string | null {
  const macOsDir = dirname(exePath)
  const contents = dirname(macOsDir)
  const bundle = dirname(contents)
  if (basename(macOsDir) !== 'MacOS' || basename(contents) !== 'Contents') return null
  if (!bundle.endsWith('.app')) return null
  return bundle
}

/**
 * Whether macOS is running this bundle from a randomized read-only copy.
 *
 * Gatekeeper "app translocation" fires for a quarantined unsigned app opened
 * straight from a DMG. The app then runs from a path under
 * `/private/var/folders/.../AppTranslocation/`, which cannot be written and is
 * not where the user thinks the app lives. `install.sh` strips the quarantine
 * flag so its users never land here, but drag-from-DMG users do.
 */
export function isTranslocated(bundlePath: string): boolean {
  return bundlePath.includes(`${sep}AppTranslocation${sep}`)
}

/** Whether an entry beside the installed bundle is ours to delete. */
export function isOrphanedUpdateEntry(name: string): boolean {
  return ORPHAN_RE.test(name)
}

function stagingDirName(pid: number, stamp: number): string {
  return `${STAGING_PREFIX}${pid}-${stamp}`
}

function backupDirName(pid: number, stamp: number): string {
  return `${BACKUP_PREFIX}${pid}-${stamp}.app`
}

/** True when the bundle can be replaced in place: writable parent, no translocation. */
export async function canSwapBundle(bundlePath: string): Promise<boolean> {
  if (isTranslocated(bundlePath)) return false
  try {
    await access(dirname(bundlePath), FS.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Delete staging and backup directories a previous run left behind.
 *
 * A force-quit between "extracted" and "swapped" strands ~600MB beside the
 * app. Only names matching {@link ORPHAN_RE} are touched, and only inside the
 * directory the running bundle lives in.
 */
export async function sweepOrphans(bundlePath: string): Promise<string[]> {
  const parent = dirname(bundlePath)
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch {
    return removed
  }
  for (const name of entries) {
    if (!isOrphanedUpdateEntry(name)) continue
    const target = join(parent, name)
    if (target === bundlePath) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      // A leftover we cannot remove is not worth failing a launch over.
    }
  }
  return removed
}

export interface StagedMacUpdate {
  version: string
  /** The verified replacement bundle, already beside the installed one. */
  stagedBundle: string
  /** Its containing staging directory, removed after the swap. */
  stagingDir: string
}

export interface StageOptions {
  bundlePath: string
  version: string
  /** Absolute download URL, built by the caller from the release tag. */
  zipUrl: string
  /** Base64 sha512 from the manifest. */
  sha512: string
  onProgress: (percent: number) => void
  onInstallStart: () => void
  signal?: AbortSignal
}

/**
 * Download, verify and expand the new bundle next to the installed one.
 *
 * Everything slow happens here, while the app is still running and can report
 * progress. What remains afterwards is two renames.
 */
export async function stageMacUpdate(options: StageOptions): Promise<StagedMacUpdate> {
  const { bundlePath, version, zipUrl, sha512, onProgress, onInstallStart, signal } = options
  const parent = dirname(bundlePath)
  const stamp = Date.now()
  const stagingDir = join(parent, stagingDirName(process.pid, stamp))

  // The zip goes to the system temp dir: it is read once and deleted, so it
  // does not need to share a volume with the bundle the way staging does.
  const downloadDir = await mkdtemp(join(tmpdir(), 'phosphor-update-'))
  const zipPath = join(downloadDir, 'phosphor.zip')

  try {
    await downloadFile(zipUrl, zipPath, onProgress, signal)

    const actual = await sha512Base64(zipPath)
    if (actual !== sha512) {
      throw new Error(`sha512 mismatch for ${basename(zipUrl)}`)
    }

    onInstallStart()
    await mkdir(stagingDir, { recursive: true })
    // `ditto -x -k`, not `unzip`: it is the tool that preserves the symlinks,
    // permissions and extended attributes an .app bundle's signature is
    // computed over. `unzip` flattens enough of that to break verification.
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, stagingDir])

    const stagedBundle = await findBundle(stagingDir)
    if (!stagedBundle) throw new Error('no .app bundle inside the downloaded archive')

    // Downloaded by us over HTTPS rather than by a browser, so there should be
    // no quarantine flag — clear it anyway, exactly as install.sh does, or the
    // relaunched app can be translocated and lose the next update.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagedBundle]).catch(() => {})

    // Verify BEFORE the swap. A bundle that fails here never reaches
    // /Applications, so the worst case is a failed update, not a broken app.
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedBundle])

    const stagedVersion = await bundleVersion(stagedBundle)
    if (stagedVersion !== version) {
      throw new Error(`archive contains ${stagedVersion ?? 'no version'}, expected ${version}`)
    }

    return { version, stagedBundle, stagingDir }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    throw error
  } finally {
    await rm(downloadDir, { recursive: true, force: true })
  }
}

/**
 * Replace the installed bundle with the staged one.
 *
 * Both renames are within one directory on one volume, so each is atomic. If
 * the second fails the first is undone, leaving the running app exactly as it
 * was — the case worth designing for, since the alternative is a user with no
 * Phosphor at all.
 *
 * Returns the backup path, which the relauncher deletes once we have exited.
 */
export async function swapBundle(bundlePath: string, staged: StagedMacUpdate): Promise<string> {
  const parent = dirname(bundlePath)
  const backup = join(parent, backupDirName(process.pid, Date.now()))

  await rename(bundlePath, backup)
  try {
    await rename(staged.stagedBundle, bundlePath)
  } catch (error) {
    await rename(backup, bundlePath).catch(() => {})
    throw error
  }
  await rm(staged.stagingDir, { recursive: true, force: true })
  return backup
}

/**
 * Hand off to a detached shell that waits for us to exit, then reopens Phosphor.
 *
 * A fixed sleep is not good enough. `before-quit` in electron/main.ts SIGTERMs
 * every pi child, kills the PTYs and closes the watchers before quitting, and
 * main.ts holds a single-instance lock: a replacement that starts too early
 * takes the `second-instance` path, focuses the window that is already dying,
 * and exits — leaving the user with no app. So the script polls for the pid.
 *
 * Paths arrive as positional arguments, never interpolated into the script
 * body, and the script itself is written to our own temp directory.
 */
export async function spawnRelauncher(bundlePath: string, backupPath: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-relaunch-'))
  const script = join(dir, 'relaunch.sh')
  await writeFile(
    script,
    [
      'set -u',
      'pid="$1"; app="$2"; backup="$3"; dir="$4"',
      // 300 * 0.2s = 60s. A shutdown that outlasts that is hung; reopening is
      // still better than leaving the user staring at nothing.
      'i=0',
      'while [ "$i" -lt 300 ] && kill -0 "$pid" 2>/dev/null; do',
      '  sleep 0.2',
      '  i=$((i+1))',
      'done',
      'rm -rf "$backup" 2>/dev/null || true',
      // `open`, not a direct exec of the binary: LaunchServices is what
      // registers the new process, gives it a Dock tile and lets it accept
      // activation. -n forces a new instance rather than poking the old one.
      '/usr/bin/open -n "$app" || true',
      'rm -rf "$dir" 2>/dev/null || true',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )

  const child = spawn('/bin/sh', [script, String(process.pid), bundlePath, backupPath, dir], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

// ---------- internals ----------

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastReported = -1

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total <= 0) return
    const percent = Math.min(100, Math.floor((received / total) * 100))
    // Whole percents only: a 170MB body is ~1400 chunks, and every one of them
    // would otherwise broadcast an IPC message to every window.
    if (percent !== lastReported) {
      lastReported = percent
      onProgress(percent)
    }
  })
  await pipeline(source, createWriteStream(dest))
}

async function sha512Base64(path: string): Promise<string> {
  const hash = createHash('sha512')
  hash.update(await readFile(path))
  return hash.digest('base64')
}

async function findBundle(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  return app ? join(dir, app.name) : null
}

/** `CFBundleShortVersionString`, via the plist reader macOS always ships. */
async function bundleVersion(bundlePath: string): Promise<string | null> {
  try {
    const out = await run('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleShortVersionString',
      join(bundlePath, 'Contents', 'Info.plist'),
    ])
    return out.trim() || null
  } catch {
    return null
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else
        reject(new Error(`${basename(command)} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}
