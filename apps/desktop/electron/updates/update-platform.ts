import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bundlePathFromExe, canSwapBundle } from './mac-installer'

/**
 * What this install is and where its release manifest lives: build flags, the
 * running bundle and the platform. No network and no `electron-updater`;
 * `updater.ts` caches the chosen path and acts on it.
 */

export type UpdatePathKind = 'updater' | 'mac-self' | 'manual'

/**
 * Which mechanism this install can use.
 *
 * CI stamps `phosphorSigned` into the packaged package.json only when the signing
 * secrets were present (and always for Linux, where AppImage self-updates
 * without signing). Reading a build-time flag beats probing at runtime: the
 * answer is known before the first check, so the UI never promises a restart
 * it cannot deliver.
 */
export async function computeUpdatePath(): Promise<UpdatePathKind> {
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

export function macBundlePath(): string | null {
  return bundlePathFromExe(app.getPath('exe'))
}

export function readPackagedFlag(): boolean | null {
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
 * electron-builder names the manifest per platform AND per non-primary arch:
 * an arm64 Linux build publishes `latest-linux-arm64.yml` alongside the x64
 * `latest-linux.yml`. Polling the x64 file on arm64 happened to work only
 * because every arch of a release carries the same version number.
 */
export function manifestName(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'win32') return 'latest.yml'
  return process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
}
