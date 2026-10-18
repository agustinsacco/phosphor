import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as MacInstallerModule from './mac-installer'

/**
 * Frozen characterization of `updater.ts` through its public entries:
 * platform selection, the manual and macOS self-install paths, check
 * coalescing, staged-update reuse, failure fallbacks and the startup sweep and
 * timer. Only Electron, the network, electron-updater and the disk-touching
 * mac-installer steps are faked; manifest parsing, asset picking and reading
 * the packaged `package.json` are real.
 */

const f = vi.hoisted(() => ({
  packaged: true,
  appDir: '',
  exe: '/Applications/Phosphor.app/Contents/MacOS/Phosphor',
  body: '',
  ok: true,
  updaterLoads: 0,
  handlers: new Map<string, (value: unknown) => void>(),
  autoUpdater: {} as Record<string, unknown>,
  windows: [] as { isDestroyed: () => boolean; webContents: { send: (...a: unknown[]) => void } }[],
  fetch: vi.fn(),
  canSwap: vi.fn(),
  sweep: vi.fn(),
  stage: vi.fn(),
  discard: vi.fn(),
  updaterCheck: vi.fn(),
  install: vi.fn(),
  openExternal: vi.fn(),
  approve: vi.fn(),
  quit: vi.fn(),
  log: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return f.packaged
    },
    getPath: (name: string) => (name === 'exe' ? f.exe : '/unused'),
    getAppPath: () => f.appDir,
    getVersion: () => '1.0.0',
    quit: f.quit,
  },
  BrowserWindow: { getAllWindows: () => f.windows },
  shell: { openExternal: f.openExternal },
}))
vi.mock('../debug-log', () => ({ log: f.log }))
vi.mock('../shutdown-approval', () => ({
  shutdownApproval: { request: f.approve, releaseFailedUpdate: vi.fn(), allowUpdateQuit: vi.fn() },
}))
vi.mock('./mac-installer', async (importOriginal) => ({
  ...(await importOriginal<typeof MacInstallerModule>()),
  canSwapBundle: f.canSwap,
  sweepOrphans: f.sweep,
  stageMacUpdate: f.stage,
  discardStagedUpdate: f.discard,
}))

const RELEASES = 'https://github.com/agustinsacco/Phosphor/releases/latest'
const DOWNLOAD = `${RELEASES}/download`
const BUNDLE = '/Applications/Phosphor.app'
const MAC_MANIFEST = (version: string, armUrl = `Phosphor-${version}-arm64-mac.zip`): string =>
  [
    `version: ${version}`,
    'files:',
    `  - url: Phosphor-${version}-mac.zip`,
    '    sha512: x64hash',
    '    size: 1',
    `  - url: ${armUrl}`,
    '    sha512: armhash',
    '    size: 2',
    `path: Phosphor-${version}-mac.zip`,
    'sha512: x64hash',
  ].join('\n')

const originalPlatform = process.platform
const originalArch = process.arch
const appDir = mkdtempSync(join(tmpdir(), 'phosphor-updater-char-'))

function setHost(platform: string, arch = 'arm64'): void {
  Object.defineProperty(process, 'platform', { value: platform })
  Object.defineProperty(process, 'arch', { value: arch })
}

/** `undefined` writes no flag at all; `null` removes package.json entirely. */
function writeSignedFlag(value: boolean | string | undefined | null): void {
  rmSync(join(appDir, 'package.json'), { force: true })
  if (value === null) return
  const pkg = value === undefined ? {} : { phosphorSigned: value }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(pkg))
}

const fetchedUrls = (): unknown[] => f.fetch.mock.calls.map((call) => call[0])

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  f.packaged = true
  f.appDir = appDir
  f.exe = `${BUNDLE}/Contents/MacOS/Phosphor`
  f.body = MAC_MANIFEST('2.0.0')
  f.ok = true
  f.windows = []
  f.handlers.clear()
  f.updaterLoads = 0
  f.autoUpdater = {
    on: (event: string, handler: (value: unknown) => void) => f.handlers.set(event, handler),
    checkForUpdates: f.updaterCheck,
    quitAndInstall: f.install,
  }
  vi.doMock('electron-updater', () => {
    f.updaterLoads += 1
    return { default: { autoUpdater: f.autoUpdater } }
  })
  f.fetch.mockImplementation(async () => ({ ok: f.ok, text: async () => f.body }))
  vi.stubGlobal('fetch', f.fetch)
  vi.stubEnv('APPIMAGE', undefined)
  f.canSwap.mockResolvedValue(true)
  f.sweep.mockResolvedValue([])
  f.discard.mockResolvedValue(undefined)
  f.updaterCheck.mockResolvedValue(undefined)
  f.stage.mockImplementation(async ({ version }: { version: string }) => ({
    version,
    stagedBundle: `/stage-${version}/Phosphor.app`,
    stagingDir: `/stage-${version}`,
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setHost('darwin')
  writeSignedFlag(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  Object.defineProperty(process, 'arch', { value: originalArch })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

afterAll(() => rmSync(appDir, { recursive: true, force: true }))

it('never imports electron-updater or reaches the network when unpackaged', async () => {
  f.packaged = false
  const setInterval = vi.spyOn(globalThis, 'setInterval')
  const updater = await import('./updater')
  expect(updater.currentUpdateState()).toEqual({ phase: 'idle' })
  updater.startUpdateChecks()
  await updater.checkForUpdates()
  await new Promise((resolve) => setImmediate(resolve))
  expect(updater.currentUpdateState()).toEqual({ phase: 'unsupported' })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.updaterLoads).toBe(0)
  expect(f.sweep).not.toHaveBeenCalled()
  expect(f.canSwap).not.toHaveBeenCalled()
  expect(setInterval).not.toHaveBeenCalled()
})

it('uses electron-updater for a signed Linux AppImage, flag as boolean or string', async () => {
  setHost('linux', 'x64')
  vi.stubEnv('APPIMAGE', '/home/u/Phosphor.AppImage')
  for (const flag of [true, 'true'] as const) {
    vi.resetModules()
    vi.clearAllMocks()
    writeSignedFlag(flag)
    const updater = await import('./updater')
    await updater.checkForUpdates()
    expect(f.updaterCheck).toHaveBeenCalledTimes(1)
    expect(f.fetch).not.toHaveBeenCalled()
    // No events are wired outside startUpdateChecks, so the check stays "checking".
    expect(updater.currentUpdateState()).toEqual({ phase: 'checking' })
  }
})

it('polls the manifest by hand for a deb install or an unsigned AppImage', async () => {
  setHost('linux', 'x64')
  f.body = 'version: 2.0.0\npath: Phosphor-2.0.0.AppImage\n'
  writeSignedFlag(true)
  const deb = await import('./updater')
  await deb.checkForUpdates()
  expect(f.updaterCheck).not.toHaveBeenCalled()
  expect(fetchedUrls()).toEqual([`${DOWNLOAD}/latest-linux.yml`])
  expect(f.fetch.mock.calls[0]![1]).toEqual({ redirect: 'follow' })
  expect(deb.currentUpdateState()).toEqual({
    phase: 'manual-download',
    version: '2.0.0',
    releaseUrl: RELEASES,
  })

  vi.resetModules()
  vi.stubEnv('APPIMAGE', '/home/u/Phosphor.AppImage')
  writeSignedFlag(false)
  const unsignedAppImage = await import('./updater')
  await unsignedAppImage.checkForUpdates()
  expect(f.updaterCheck).not.toHaveBeenCalled()
  expect(unsignedAppImage.currentUpdateState().phase).toBe('manual-download')
  expect(f.updaterLoads).toBe(0)
})

it('names the arm64 Linux and the Windows manifests per platform and arch', async () => {
  f.body = 'version: 1.0.0\n'
  setHost('linux', 'arm64')
  await (await import('./updater')).checkForUpdates()
  vi.resetModules()
  setHost('win32', 'x64')
  const windows = await import('./updater')
  await windows.checkForUpdates()
  expect(fetchedUrls()).toEqual([`${DOWNLOAD}/latest-linux-arm64.yml`, `${DOWNLOAD}/latest.yml`])
  expect(windows.currentUpdateState()).toEqual({ phase: 'idle' })
})

it('uses electron-updater for signed macOS and Windows builds without probing the bundle', async () => {
  writeSignedFlag(true)
  await (await import('./updater')).checkForUpdates()
  vi.resetModules()
  setHost('win32', 'x64')
  await (await import('./updater')).checkForUpdates()
  expect(f.updaterCheck).toHaveBeenCalledTimes(2)
  expect(f.canSwap).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('self-installs unsigned macOS from the arch-matched zip, reporting progress', async () => {
  const phases: unknown[] = []
  f.stage.mockImplementation(async (options: Record<string, unknown>) => {
    const updater = await import('./updater')
    phases.push(updater.currentUpdateState())
    ;(options.onProgress as (percent: number) => void)(41.6)
    phases.push(updater.currentUpdateState())
    ;(options.onInstallStart as () => void)()
    phases.push(updater.currentUpdateState())
    return { version: '2.0.0', stagedBundle: '/s/Phosphor.app', stagingDir: '/s' }
  })
  const updater = await import('./updater')
  await updater.checkForUpdates()
  expect(f.canSwap).toHaveBeenCalledExactlyOnceWith(BUNDLE)
  expect(fetchedUrls()).toEqual([`${DOWNLOAD}/latest-mac.yml`])
  expect(f.stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      bundlePath: BUNDLE,
      version: '2.0.0',
      zipUrl: `${DOWNLOAD}/Phosphor-2.0.0-arm64-mac.zip`,
      sha512: 'armhash',
    }),
  )
  expect(phases).toEqual([
    { phase: 'downloading', version: '2.0.0', progressPercent: 0 },
    { phase: 'downloading', version: '2.0.0', progressPercent: 42 },
    { phase: 'installing', version: '2.0.0' },
  ])
  expect(updater.currentUpdateState()).toEqual({ phase: 'downloaded', version: '2.0.0' })
})

it('falls back to a manual download for a macOS bundle it cannot replace', async () => {
  f.canSwap.mockResolvedValue(false)
  const unwritable = await import('./updater')
  await unwritable.checkForUpdates()
  expect(f.stage).not.toHaveBeenCalled()
  expect(unwritable.currentUpdateState()).toEqual({
    phase: 'manual-download',
    version: '2.0.0',
    releaseUrl: RELEASES,
  })

  vi.resetModules()
  f.canSwap.mockClear()
  f.exe = '/usr/local/bin/phosphor'
  const notABundle = await import('./updater')
  await notABundle.checkForUpdates()
  expect(f.canSwap).not.toHaveBeenCalled()
  expect(f.stage).not.toHaveBeenCalled()
  expect(notABundle.currentUpdateState().phase).toBe('manual-download')
})

it('treats an unreadable or flagless package.json as unsigned', async () => {
  writeSignedFlag(null)
  await (await import('./updater')).checkForUpdates()
  vi.resetModules()
  writeSignedFlag(undefined)
  await (await import('./updater')).checkForUpdates()
  vi.resetModules()
  writeSignedFlag('yes')
  await (await import('./updater')).checkForUpdates()
  expect(f.updaterCheck).not.toHaveBeenCalled()
  expect(f.stage).toHaveBeenCalledTimes(3)
})

it('resolves the install path once per process and caches it', async () => {
  const updater = await import('./updater')
  await updater.checkForUpdates()
  writeSignedFlag(true)
  f.canSwap.mockResolvedValue(false)
  await updater.checkForUpdates()
  expect(f.canSwap).toHaveBeenCalledTimes(1)
  expect(f.updaterCheck).not.toHaveBeenCalled()
  expect(f.fetch).toHaveBeenCalledTimes(2)
  const resolved = f.log.mock.calls.filter((call) => call[1] === 'path resolved')
  expect(resolved).toEqual([['updates', 'path resolved', { path: 'mac-self', platform: 'darwin' }]])
})

it('coalesces a check that starts while another is still running', async () => {
  let finish: () => void = () => {}
  f.stage.mockImplementationOnce(
    ({ version }: { version: string }) =>
      new Promise((resolve) => {
        finish = () => resolve({ version, stagedBundle: '/s/Phosphor.app', stagingDir: '/s' })
      }),
  )
  const updater = await import('./updater')
  const first = updater.checkForUpdates()
  await vi.waitFor(() => expect(f.stage).toHaveBeenCalledTimes(1))
  await updater.checkForUpdates()
  expect(f.fetch).toHaveBeenCalledTimes(1)
  finish()
  await first
  expect(updater.currentUpdateState()).toEqual({ phase: 'downloaded', version: '2.0.0' })
  await updater.checkForUpdates()
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(f.stage).toHaveBeenCalledTimes(1)
})

it('reuses a staged update of the same version instead of downloading it again', async () => {
  const updater = await import('./updater')
  await updater.checkForUpdates()
  await updater.checkForUpdates()
  await updater.checkForUpdates()
  expect(f.fetch).toHaveBeenCalledTimes(3)
  expect(f.stage).toHaveBeenCalledTimes(1)
  expect(f.discard).not.toHaveBeenCalled()
  expect(updater.currentUpdateState()).toEqual({ phase: 'downloaded', version: '2.0.0' })
})

it('degrades a failed or impossible macOS self-install to the release link', async () => {
  f.stage.mockRejectedValueOnce(new Error('sha512 mismatch'))
  const failed = await import('./updater')
  await failed.checkForUpdates()
  expect(failed.currentUpdateState()).toEqual({
    phase: 'manual-download',
    version: '2.0.0',
    releaseUrl: RELEASES,
  })
  expect(f.log).toHaveBeenCalledWith('updates', 'macOS self-install failed', {
    message: 'Error: sha512 mismatch',
  })

  for (const [arch, body] of [
    ['x64', MAC_MANIFEST('2.0.0').replace(/Phosphor-2\.0\.0-mac\.zip/g, 'notes.txt')],
    ['arm64', MAC_MANIFEST('2.0.0', '..%2Fevil-arm64-mac.zip')],
  ] as const) {
    vi.resetModules()
    f.stage.mockClear()
    setHost('darwin', arch)
    f.body = body
    const noAsset = await import('./updater')
    await noAsset.checkForUpdates()
    expect(f.stage).not.toHaveBeenCalled()
    expect(noAsset.currentUpdateState()).toEqual({
      phase: 'manual-download',
      version: '2.0.0',
      releaseUrl: RELEASES,
    })
  }
})

it('falls silent when the manifest is unavailable, unparseable or not newer', async () => {
  const cases: [() => void, string][] = [
    [() => (f.ok = false), 'darwin'],
    [() => f.fetch.mockRejectedValueOnce(new Error('offline')), 'darwin'],
    [() => (f.body = 'not a manifest'), 'darwin'],
    [() => (f.body = MAC_MANIFEST('1.0.0')), 'darwin'],
    [() => (f.ok = false), 'linux'],
    [() => (f.body = 'path: x.AppImage\n'), 'linux'],
    [() => (f.body = 'version: 0.9.0\n'), 'linux'],
  ]
  for (const [arrange, platform] of cases) {
    vi.resetModules()
    f.ok = true
    f.body = MAC_MANIFEST('2.0.0')
    setHost(platform)
    arrange()
    const updater = await import('./updater')
    await updater.checkForUpdates()
    expect(updater.currentUpdateState()).toEqual({ phase: 'idle' })
  }
  expect(f.stage).not.toHaveBeenCalled()
})

it('falls silent when the electron-updater check throws', async () => {
  writeSignedFlag(true)
  f.updaterCheck.mockRejectedValueOnce(new Error('ENOTFOUND'))
  const updater = await import('./updater')
  await updater.checkForUpdates()
  expect(updater.currentUpdateState()).toEqual({ phase: 'idle' })
  expect(console.warn).toHaveBeenCalledWith('[Phosphor] update check failed:', expect.any(Error))
})

it('sweeps macOS orphans once at startup and polls on an unref-ed 30 minute timer', async () => {
  const unref = vi.fn()
  const ticks: (() => void)[] = []
  const setInterval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
  ) => {
    ticks.push(callback)
    return { unref }
  }) as unknown as typeof globalThis.setInterval)
  const clearInterval = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  const updater = await import('./updater')
  updater.startUpdateChecks()
  updater.startUpdateChecks()
  await vi.waitFor(() => expect(updater.currentUpdateState().phase).toBe('downloaded'))
  expect(f.sweep).toHaveBeenCalledExactlyOnceWith(BUNDLE)
  expect(f.sweep.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]!)
  expect(setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30 * 60 * 1000)
  expect(unref).toHaveBeenCalledTimes(1)
  expect(f.updaterLoads).toBe(0)

  ticks[0]!()
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
  updater.stopUpdateChecks()
  expect(clearInterval).toHaveBeenCalledExactlyOnceWith({ unref })
})

it('skips the sweep off macOS and degrades a failed startup to idle', async () => {
  vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({
    unref: () => {},
  })) as unknown as typeof globalThis.setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  setHost('linux', 'x64')
  f.body = 'version: 1.0.0\n'
  const linux = await import('./updater')
  linux.startUpdateChecks()
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1))
  expect(f.sweep).not.toHaveBeenCalled()
  linux.stopUpdateChecks()

  vi.resetModules()
  setHost('darwin')
  f.sweep.mockRejectedValueOnce(new Error('EACCES'))
  const darwin = await import('./updater')
  darwin.startUpdateChecks()
  await vi.waitFor(() =>
    expect(console.warn).toHaveBeenCalledWith('[Phosphor] update init failed:', expect.any(Error)),
  )
  expect(darwin.currentUpdateState()).toEqual({ phase: 'idle' })
  darwin.stopUpdateChecks()
})

it('wires electron-updater events into state and never installs on quit', async () => {
  vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({
    unref: () => {},
  })) as unknown as typeof globalThis.setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  writeSignedFlag(true)
  const send = vi.fn()
  f.windows = [
    { isDestroyed: () => false, webContents: { send } },
    { isDestroyed: () => true, webContents: { send: () => expect.fail('destroyed window') } },
  ]
  const updater = await import('./updater')
  updater.startUpdateChecks()
  await vi.waitFor(() => expect(f.updaterCheck).toHaveBeenCalledTimes(1))
  expect(f.autoUpdater).toMatchObject({
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null,
  })
  expect([...f.handlers.keys()]).toEqual([
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ])
  f.handlers.get('update-available')!({ version: '2.0.0' })
  f.handlers.get('download-progress')!({ percent: 12.4 })
  f.handlers.get('error')!(new Error('net'))
  f.handlers.get('update-available')!({ version: '2.0.0' })
  f.handlers.get('update-downloaded')!({ version: '2.0.0' })
  f.handlers.get('update-not-available')!(undefined)
  expect(send.mock.calls).toEqual([
    ['updates:event', { phase: 'checking' }],
    ['updates:event', { phase: 'downloading', version: '2.0.0', progressPercent: 0 }],
    ['updates:event', { phase: 'downloading', version: '2.0.0', progressPercent: 12 }],
    ['updates:event', { phase: 'idle' }],
    ['updates:event', { phase: 'downloading', version: '2.0.0', progressPercent: 0 }],
    ['updates:event', { phase: 'downloaded', version: '2.0.0' }],
  ])
  expect(console.warn).toHaveBeenCalledWith('[Phosphor] updater error:', 'net')
  expect(f.install).not.toHaveBeenCalled()
  expect(f.updaterLoads).toBe(1)
  updater.stopUpdateChecks()
})

it('opens the release page for a manual download and ignores a click with nothing staged', async () => {
  f.canSwap.mockResolvedValue(false)
  const updater = await import('./updater')
  await updater.restartAndInstall()
  expect(f.approve).not.toHaveBeenCalled()
  await updater.checkForUpdates()
  await updater.restartAndInstall()
  expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(RELEASES)
  expect(f.approve).not.toHaveBeenCalled()
})
