import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
// Type-only: erased at compile time, so the runtime import below stays lazy.
import type * as ElectronUpdater from 'electron-updater'
import { log } from '../debug-log'
import {
  IDLE,
  isNewerVersion,
  reduceUpdate,
  type UpdateEvent,
  type UpdateState,
} from './update-state'
import {
  bundlePathFromExe,
  canSwapBundle,
  parseMacManifest,
  pickMacZip,
  spawnRelauncher,
  stageMacUpdate,
  swapBundle,
  sweepOrphans,
  type StagedMacUpdate,
} from './mac-installer'

/**
 * Update checks against the GitHub releases the continuous-release workflow
 * publishes.
 *
 * Hard-gated on `app.isPackaged`: dev runs, the browser harness and the
 * Playwright suite must never reach the network for this. `electron-updater`
 * is imported lazily for the same reason — an unpackaged run should not even
 * load it.
 *
 * Three paths, chosen at startup rather than by waiting for a failure:
 *
 *  - **`electron-updater`** where the platform can install for itself: a
 *    signed macOS build, or a Linux AppImage (which self-updates with no
 *    signing requirement at all).
 *  - **macOS self-install** for the unsigned builds this repo actually ships.
 *    Squirrel.Mac refuses an ad-hoc signature, so `mac-installer.ts` does the
 *    download-verify-swap-relaunch by hand instead. Same one-click UX.
 *  - **Manual download** where neither works — a `.deb`, whose files the
 *    package manager owns, or a macOS bundle we cannot write to. Detection
 *    still runs; the UI offers a link rather than promising a restart that
 *    would silently do nothing.
 */

const REPO = 'agustinsacco/Phosphor'
const RELEASES_LATEST = `https://github.com/${REPO}/releases/latest`
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/latest/download`
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** Release asset names are plain files; anything else is not ours to fetch. */
const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/

let state: UpdateState = IDLE
let timer: NodeJS.Timeout | null = null
let started = false
/** Set once the macOS path has a verified bundle waiting beside the installed one. */
let stagedMac: StagedMacUpdate | null = null
/** Guards the 30-minute timer against re-entering a check that is still running. */
let checking = false

function broadcast(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:event', state)
  }
}

function apply(event: UpdateEvent): void {
  const next = reduceUpdate(state, event)
  if (next === state) return
  state = next
  broadcast()
}

export function currentUpdateState(): UpdateState {
  return state
}

type UpdatePathKind = 'updater' | 'mac-self' | 'manual'

/** Cached: the answer cannot change while the process runs, and it stats the disk. */
let updatePathKind: UpdatePathKind | null = null

/**
 * Which mechanism this install can use.
 *
 * CI stamps `phosphorSigned` into the packaged package.json only when the signing
 * secrets were present (and always for Linux, where AppImage self-updates
 * without signing). Reading a build-time flag beats probing at runtime: the
 * answer is known before the first check, so the UI never promises a restart
 * it cannot deliver.
 */
async function resolveUpdatePath(): Promise<UpdatePathKind> {
  if (updatePathKind) return updatePathKind
  updatePathKind = await computeUpdatePath()
  log('updates', 'path resolved', { path: updatePathKind, platform: process.platform })
  return updatePathKind
}

async function computeUpdatePath(): Promise<UpdatePathKind> {
  // deb/rpm installs are owned by the package manager; electron-updater cannot
  // replace those files, and APPIMAGE is set only when running as an AppImage.
  if (process.platform === 'linux') {
    return process.env.APPIMAGE && readPackagedFlag() ? 'updater' : 'manual'
  }
  if (readPackagedFlag()) return 'updater'
  if (process.platform !== 'darwin') return 'manual'

  // Unsigned macOS. Self-install is possible only where the bundle is a real
  // installed .app we are allowed to replace.
  const bundle = macBundlePath()
  if (!bundle) return 'manual'
  return (await canSwapBundle(bundle)) ? 'mac-self' : 'manual'
}

function macBundlePath(): string | null {
  return bundlePathFromExe(app.getPath('exe'))
}

function readPackagedFlag(): boolean | null {
  try {
    // `getAppPath()` is the asar root in a packaged app, which is where
    // electron-builder writes the package.json its extraMetadata patched.
    const raw = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { phosphorSigned?: boolean | string }
    // CLI-injected metadata arrives as the STRING "true", not a boolean.
    return pkg.phosphorSigned === true || pkg.phosphorSigned === 'true'
  } catch {
    return null
  }
}

/**
 * `electron-updater` is CommonJS and the packaged main bundle is ESM
 * (`"type": "module"`), so its exports arrive under `.default`. Destructuring
 * `autoUpdater` off the namespace yields **undefined** — Node's lexer lists the
 * name but the value is a lazy getter that only exists on the CJS exports
 * object. The result was `TypeError: Cannot set properties of undefined
 * (setting 'autoDownload')` on the very first check in a packaged build, i.e.
 * self-updating never worked outside dev, where this file is short-circuited.
 */
async function importUpdater(): Promise<typeof ElectronUpdater> {
  const mod = (await import('electron-updater')) as unknown as {
    default?: typeof ElectronUpdater
  } & typeof ElectronUpdater
  return mod.default ?? mod
}

/**
 * electron-builder names the manifest per platform AND per non-primary arch:
 * an arm64 Linux build publishes `latest-linux-arm64.yml` alongside the x64
 * `latest-linux.yml`. Polling the x64 file on arm64 happened to work only
 * because every arch of a release carries the same version number.
 */
function manifestName(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'win32') return 'latest.yml'
  return process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
}

/** A static asset on the release, not the API: no auth, no rate limit. */
async function fetchManifest(): Promise<string | null> {
  try {
    const response = await fetch(`${DOWNLOAD_BASE}/${manifestName()}`, { redirect: 'follow' })
    if (!response.ok) return null
    return await response.text()
  } catch {
    // Offline, DNS failure, GitHub down — all the same to the user: nothing.
    return null
  }
}

/** Poll the release manifest directly, for installs that cannot self-update. */
async function checkManually(): Promise<void> {
  apply({ type: 'check-started' })
  const body = await fetchManifest()
  if (!body) {
    apply({ type: 'error' })
    return
  }
  // The manifest is small YAML; the only field needed is `version:`.
  const version = /^version:\s*(.+)$/m.exec(body)?.[1]?.trim()
  if (!version) {
    apply({ type: 'error' })
    return
  }
  if (isNewerVersion(version, app.getVersion())) {
    apply({ type: 'manual-required', version, releaseUrl: RELEASES_LATEST })
  } else {
    apply({ type: 'update-not-available' })
  }
}

/**
 * The unsigned-macOS path: detect, download, verify and stage, all in the
 * background, so the pill reaches "Restart to update" exactly as it does on
 * Linux. The restart itself is still only ever a user click.
 */
async function checkMacSelf(): Promise<void> {
  apply({ type: 'check-started' })
  const bundle = macBundlePath()
  if (!bundle) {
    apply({ type: 'error' })
    return
  }

  const body = await fetchManifest()
  const manifest = body ? parseMacManifest(body) : null
  if (!manifest) {
    apply({ type: 'error' })
    return
  }
  if (!isNewerVersion(manifest.version, app.getVersion())) {
    apply({ type: 'update-not-available' })
    return
  }
  // Already staged and waiting: a later check must not re-download 170MB.
  if (stagedMac?.version === manifest.version) {
    apply({ type: 'update-downloaded', version: manifest.version })
    return
  }

  const file = pickMacZip(manifest.files, process.arch)
  if (!file || !SAFE_ASSET_NAME.test(file.url)) {
    log('updates', 'no usable mac asset', { version: manifest.version, arch: process.arch })
    apply({ type: 'manual-required', version: manifest.version, releaseUrl: RELEASES_LATEST })
    return
  }

  apply({ type: 'update-available', version: manifest.version })
  try {
    stagedMac = await stageMacUpdate({
      bundlePath: bundle,
      version: manifest.version,
      zipUrl: `${DOWNLOAD_BASE}/${file.url}`,
      sha512: file.sha512,
      onProgress: (percent) => apply({ type: 'download-progress', percent }),
      onInstallStart: () => apply({ type: 'install-started' }),
    })
    log('updates', 'staged macOS update', { version: stagedMac.version })
    apply({ type: 'update-downloaded', version: manifest.version })
  } catch (error) {
    stagedMac = null
    log('updates', 'macOS self-install failed', { message: String(error) })
    // Degrade to the link rather than to silence: the user keeps a way out.
    apply({ type: 'install-failed', version: manifest.version, releaseUrl: RELEASES_LATEST })
  }
}

async function checkWithUpdater(): Promise<void> {
  apply({ type: 'check-started' })
  try {
    const { autoUpdater } = await importUpdater()
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.warn('[Phosphor] update check failed:', error)
    apply({ type: 'error' })
  }
}

async function wireUpdaterEvents(): Promise<void> {
  const { autoUpdater } = await importUpdater()

  // Downloading is automatic; INSTALLING never is. Nothing in this module
  // calls quitAndInstall on a timer — only an explicit user click does.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info: { version: string }) => {
    apply({ type: 'update-available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => apply({ type: 'update-not-available' }))
  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    apply({ type: 'download-progress', percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    apply({ type: 'update-downloaded', version: info.version })
  })
  autoUpdater.on('error', (error: Error) => {
    console.warn('[Phosphor] updater error:', error.message)
    apply({ type: 'error' })
  })
}

/** Check now, on whichever path this install supports. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return
  // A macOS download takes minutes; the periodic timer would otherwise start a
  // second one on top of it.
  if (checking) return
  checking = true
  try {
    switch (await resolveUpdatePath()) {
      case 'updater':
        await checkWithUpdater()
        break
      case 'mac-self':
        await checkMacSelf()
        break
      default:
        await checkManually()
    }
  } finally {
    checking = false
  }
}

/**
 * Begin periodic checks. Safe to call once from `whenReady`; a no-op in dev,
 * under the E2E stub, and on repeat calls.
 */
export function startUpdateChecks(): void {
  if (started) return
  if (!app.isPackaged) {
    state = { phase: 'unsupported' }
    return
  }
  started = true

  // Catch, don't just `void`: an unguarded rejection here surfaced as a raw
  // UnhandledPromiseRejectionWarning in the packaged app instead of the silent
  // degrade this module promises everywhere else.
  void (async () => {
    await sweepMacOrphans()
    if ((await resolveUpdatePath()) === 'updater') await wireUpdaterEvents()
    await checkForUpdates()
  })().catch((error: unknown) => {
    console.warn('[Phosphor] update init failed:', error)
    apply({ type: 'error' })
  })

  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
  // Update polling must never be the reason the process stays alive.
  timer.unref()
}

/**
 * Remove staging and backup directories a previous run left beside the app.
 *
 * A force-quit or crash between "extracted" and "swapped" strands several
 * hundred MB in `/Applications`. Nothing else cleans those up, and the next
 * launch is the only moment we know no swap is in flight.
 */
async function sweepMacOrphans(): Promise<void> {
  if (process.platform !== 'darwin') return
  const bundle = macBundlePath()
  if (!bundle) return
  const removed = await sweepOrphans(bundle)
  if (removed.length > 0) log('updates', 'swept stale update dirs', { removed })
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}

/**
 * Apply a staged update, or open the release page when this install cannot
 * apply one itself. Always user-initiated.
 */
export async function restartAndInstall(): Promise<void> {
  if (state.phase === 'manual-download') {
    await shell.openExternal(state.releaseUrl ?? RELEASES_LATEST)
    return
  }
  if (state.phase !== 'downloaded') return

  if (stagedMac) {
    await installStagedMac(stagedMac)
    return
  }

  const { autoUpdater } = await importUpdater()
  // isSilent=false so the installer UI shows if the platform has one;
  // isForceRunAfter=true so the user lands back in Phosphor, not on the desktop.
  autoUpdater.quitAndInstall(false, true)
}

/**
 * Swap the staged bundle in, arrange the relaunch, then quit.
 *
 * The relauncher is spawned BEFORE `app.quit()` because quitting is the signal
 * it waits on — and it is spawned only after a successful swap, so a failed
 * swap leaves a running app rather than an app that quits into nothing.
 */
async function installStagedMac(staged: StagedMacUpdate): Promise<void> {
  const bundle = macBundlePath()
  if (!bundle) return
  try {
    const backup = await swapBundle(bundle, staged)
    await spawnRelauncher(bundle, backup)
    stagedMac = null
    log('updates', 'installing macOS update', { version: staged.version })
    app.quit()
  } catch (error) {
    stagedMac = null
    log('updates', 'macOS swap failed', { message: String(error) })
    apply({ type: 'install-failed', version: staged.version, releaseUrl: RELEASES_LATEST })
  }
}
