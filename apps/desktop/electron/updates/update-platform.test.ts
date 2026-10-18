import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeUpdatePath, macBundlePath, manifestName, readPackagedFlag } from './update-platform'

/**
 * Path selection against the real disk: the packaged `package.json` is a real
 * file and `canSwapBundle` stats real directories. Only Electron's `app` is
 * faked, to point at them.
 */

const f = vi.hoisted(() => ({ exe: '', appDir: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'exe' ? f.exe : '/unused'),
    getAppPath: () => f.appDir,
  },
}))

const root = mkdtempSync(join(tmpdir(), 'phosphor-update-platform-'))
const originalPlatform = process.platform
const originalArch = process.arch

function setHost(platform: string, arch = 'x64'): void {
  Object.defineProperty(process, 'platform', { value: platform })
  Object.defineProperty(process, 'arch', { value: arch })
}

/** Writes the packaged package.json verbatim; `null` removes it. */
function writePackageJson(raw: string | null): void {
  rmSync(join(f.appDir, 'package.json'), { force: true })
  if (raw !== null) writeFileSync(join(f.appDir, 'package.json'), raw)
}

const signed = (value: unknown): void => writePackageJson(JSON.stringify({ phosphorSigned: value }))

/** Creates `<parent>/Phosphor.app/Contents/MacOS` and points the exe inside it. */
function installBundle(parent: string): string {
  const bundle = join(parent, 'Phosphor.app')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  f.exe = join(bundle, 'Contents', 'MacOS', 'Phosphor')
  return bundle
}

beforeEach(() => {
  f.appDir = mkdtempSync(join(root, 'app-'))
  installBundle(mkdtempSync(join(root, 'Applications-')))
  vi.stubEnv('APPIMAGE', undefined)
  signed(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  Object.defineProperty(process, 'arch', { value: originalArch })
  vi.unstubAllEnvs()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readPackagedFlag', () => {
  it('accepts the boolean and the CLI-injected string "true"', () => {
    for (const value of [true, 'true']) {
      signed(value)
      expect(readPackagedFlag()).toBe(true)
    }
  })

  it('treats every other value, or no flag, as unsigned', () => {
    for (const value of [false, 'false', 'TRUE', 'yes', 1, null]) {
      signed(value)
      expect(readPackagedFlag()).toBe(false)
    }
    writePackageJson('{}')
    expect(readPackagedFlag()).toBe(false)
  })

  it('returns null when package.json is missing or not JSON', () => {
    writePackageJson(null)
    expect(readPackagedFlag()).toBeNull()
    writePackageJson('{ not json')
    expect(readPackagedFlag()).toBeNull()
  })
})

describe('computeUpdatePath', () => {
  it('uses electron-updater only for a signed AppImage on Linux', async () => {
    setHost('linux')
    signed(true)
    expect(await computeUpdatePath()).toBe('manual')
    vi.stubEnv('APPIMAGE', '')
    expect(await computeUpdatePath()).toBe('manual')
    vi.stubEnv('APPIMAGE', '/home/u/Phosphor.AppImage')
    expect(await computeUpdatePath()).toBe('updater')
    signed('true')
    expect(await computeUpdatePath()).toBe('updater')
    signed(false)
    expect(await computeUpdatePath()).toBe('manual')
    writePackageJson(null)
    expect(await computeUpdatePath()).toBe('manual')
  })

  it('uses electron-updater for signed Windows and macOS without touching the bundle', async () => {
    signed(true)
    f.exe = '/not/a/bundle/phosphor'
    for (const platform of ['win32', 'darwin']) {
      setHost(platform)
      expect(await computeUpdatePath()).toBe('updater')
    }
    setHost('win32')
    signed(false)
    expect(await computeUpdatePath()).toBe('manual')
  })

  it('self-installs unsigned macOS only from a writable, real bundle', async () => {
    setHost('darwin', 'arm64')
    expect(await computeUpdatePath()).toBe('mac-self')

    f.exe = '/usr/local/bin/phosphor'
    expect(await computeUpdatePath()).toBe('manual')

    installBundle(join(root, 'missing-parent', 'never-created'))
    rmSync(join(root, 'missing-parent'), { recursive: true, force: true })
    expect(await computeUpdatePath()).toBe('manual')
  })

  it('refuses a translocated bundle even when its directory is writable', async () => {
    setHost('darwin', 'arm64')
    installBundle(mkdtempSync(join(root, 'AppTranslocation-')))
    expect(await computeUpdatePath()).toBe('mac-self')
    const translocated = join(root, 'private', 'AppTranslocation', 'ABC123', 'd')
    installBundle(translocated)
    expect(await computeUpdatePath()).toBe('manual')
  })

  it('refuses a bundle whose parent directory is read-only', async () => {
    setHost('darwin', 'arm64')
    const parent = mkdtempSync(join(root, 'readonly-'))
    installBundle(parent)
    chmodSync(parent, 0o555)
    try {
      expect(await computeUpdatePath()).toBe('manual')
    } finally {
      chmodSync(parent, 0o755)
    }
  })
})

describe('macBundlePath', () => {
  it('derives the .app root from the executable, or null outside a bundle', () => {
    const bundle = installBundle(join(root, 'derive'))
    expect(macBundlePath()).toBe(bundle)
    f.exe = join(root, 'derive', 'Phosphor', 'Contents', 'MacOS', 'Phosphor')
    expect(macBundlePath()).toBeNull()
  })
})

describe('manifestName', () => {
  it('names the manifest per platform and per non-primary Linux arch', () => {
    const cases: [string, string, string][] = [
      ['darwin', 'arm64', 'latest-mac.yml'],
      ['darwin', 'x64', 'latest-mac.yml'],
      ['win32', 'x64', 'latest.yml'],
      ['win32', 'arm64', 'latest.yml'],
      ['linux', 'x64', 'latest-linux.yml'],
      ['linux', 'arm64', 'latest-linux-arm64.yml'],
    ]
    for (const [platform, arch, name] of cases) {
      setHost(platform, arch)
      expect(manifestName()).toBe(name)
    }
  })
})
