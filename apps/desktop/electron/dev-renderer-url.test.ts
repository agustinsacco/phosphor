import { afterEach, describe, expect, it, vi } from 'vitest'
import { devRendererUrl } from './dev-renderer-url'

// Which document main.ts opens in its window. The window carries the privileged
// preload, so an environment variable must not choose that document for a
// packaged app. Every module main.ts imports is stubbed: importing it runs the
// whole startup, and only the window's load call is observed here.
const electron = vi.hoisted(() => {
  class FakeWindow {
    static created: FakeWindow[] = []
    static getAllWindows = (): FakeWindow[] => []
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    on = vi.fn()
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), getURL: () => '' }
    constructor() {
      FakeWindow.created.push(this)
    }
  }
  return { packaged: false, FakeWindow }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.packaged
    },
    setName: vi.fn(),
    // Nonexistent paths: the legacy userData rename must find nothing to move.
    getPath: () => '/nonexistent/phosphor-dev-renderer-url-test/userData',
    getAppPath: () => '/nonexistent/phosphor-dev-renderer-url-test/app',
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    commandLine: {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: electron.FakeWindow,
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))
vi.mock('./routines', () => ({
  startRoutines: vi.fn(),
  stopRoutines: vi.fn(),
  wakeRoutines: vi.fn(),
  routineScheduler: vi.fn(),
  hasPendingRoutineWork: vi.fn(),
}))
vi.mock('./shutdown-approval', () => ({ configureShutdownApproval: vi.fn(), shutdownApproval: {} }))
vi.mock('./routines/background', () => ({
  installRoutineBackground: vi.fn(),
  routinesKeepRunning: () => false,
}))
vi.mock('./ipc', () => ({ registerIpcHandlers: vi.fn() }))
vi.mock('./artifacts/artifact-sync', () => ({ startArtifactSync: vi.fn() }))
vi.mock('./feedback/feedback-service', () => ({ recordAppLaunch: vi.fn() }))
vi.mock('./maintenance/runtime', () => ({ maintenanceScheduler: { start: vi.fn() } }))
vi.mock('./registry', () => ({ registry: {} }))
vi.mock('./pty/pty-manager', () => ({ ptyManager: {} }))
vi.mock('./pi/mcp-cli', () => ({ disposeMcpLogins: vi.fn() }))
vi.mock('./pi/session-launch', () => ({ ensureDesktopArtifactSkill: vi.fn() }))
vi.mock('./pi/login-flow', () => ({ cancelAllLogins: vi.fn() }))
vi.mock('./pi/claude-login', () => ({ cancelAllClaudeLogins: vi.fn() }))
vi.mock('./pi/session-watcher', () => ({ unwatchAll: vi.fn() }))
vi.mock('./fs/workspace-watcher', () => ({ unwatchAllWorkspaces: vi.fn() }))
vi.mock('./account', () => ({ settleAccount: vi.fn() }))
vi.mock('./account/keyring', () => ({ configureLinuxKeyring: vi.fn() }))
vi.mock('./updates/updater', () => ({ startUpdateChecks: vi.fn(), stopUpdateChecks: vi.fn() }))
vi.mock('./window-chrome', () => ({
  applyThemeSource: vi.fn(),
  applyZoom: vi.fn(),
  backgroundFor: () => '#000000',
  hideWindowsForE2E: () => false,
  overlayFor: () => ({}),
}))
vi.mock('./store', () => ({
  getPrefs: () => ({ theme: 'dark', fonts: { uiScale: 1 } }),
  getWritingPrefs: () => ({ spellcheck: true }),
}))
vi.mock('./writing/runtime', () => ({ applySpellcheck: vi.fn() }))
vi.mock('./debug-log', () => ({ initDebugLog: vi.fn(), log: vi.fn() }))
vi.mock('./artifacts/artifact-protocol', () => ({
  artifactScheme: {},
  registerArtifactProtocol: vi.fn(),
}))
vi.mock('./fs/file-protocol', () => ({
  fileScheme: {},
  isFrameEscape: () => false,
  registerFileProtocol: vi.fn(),
}))
vi.mock('./voice/permissions', () => ({ installPermissionPolicy: vi.fn() }))

type FakeWindow = InstanceType<typeof electron.FakeWindow>

/** Runs main.ts's startup once and returns the window it created. */
async function launchMain(packaged: boolean, rendererUrl: string | undefined): Promise<FakeWindow> {
  electron.packaged = packaged
  electron.FakeWindow.created = []
  vi.stubEnv('ELECTRON_RENDERER_URL', rendererUrl)
  vi.stubEnv('PHOSPHOR_TEST_USER_DATA', undefined)
  vi.resetModules()
  // main.ts installs signal and crash handlers that would outlive the test in
  // this worker, and a dev run starts a 1s orphan poll against its parent pid.
  const processOn = vi.spyOn(process, 'on').mockImplementation(() => process)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await import('./main')
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    processOn.mockRestore()
  }
  expect(electron.FakeWindow.created).toHaveLength(1)
  const [window] = electron.FakeWindow.created
  if (!window) throw new Error('main.ts created no window')
  return window
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('main window renderer', () => {
  it('a packaged app ignores ELECTRON_RENDERER_URL and loads the bundled renderer', async () => {
    const window = await launchMain(true, 'https://attacker.example/phish.html')
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledTimes(1)
    expect(window.loadFile.mock.calls[0]).toEqual([
      expect.stringMatching(/[\\/]renderer[\\/]index\.html$/),
    ])
  })

  it('a packaged app ignores a localhost ELECTRON_RENDERER_URL too', async () => {
    const window = await launchMain(true, 'http://localhost:5173/')
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledTimes(1)
  })

  it('a packaged app without ELECTRON_RENDERER_URL loads the bundled renderer', async () => {
    const window = await launchMain(true, undefined)
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledTimes(1)
  })

  it('an unpackaged run loads the dev server named by ELECTRON_RENDERER_URL (HMR)', async () => {
    const window = await launchMain(false, 'http://localhost:5173/')
    expect(window.loadURL.mock.calls).toEqual([['http://localhost:5173/']])
    expect(window.loadFile).not.toHaveBeenCalled()
  })

  it('an unpackaged run without ELECTRON_RENDERER_URL loads the bundled renderer', async () => {
    const window = await launchMain(false, undefined)
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledTimes(1)
  })

  it('an unpackaged run treats an empty ELECTRON_RENDERER_URL as unset', async () => {
    const window = await launchMain(false, '')
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledTimes(1)
  })
})

describe('devRendererUrl', () => {
  it.each([['https://attacker.example/phish.html'], ['http://localhost:5173/'], [''], [undefined]])(
    'is undefined in a packaged app whatever ELECTRON_RENDERER_URL holds (%j)',
    (value) => {
      expect(devRendererUrl({ ELECTRON_RENDERER_URL: value }, true)).toBeUndefined()
    },
  )

  it('returns the dev server URL in an unpackaged run', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173/' }
    expect(devRendererUrl(env, false)).toBe('http://localhost:5173/')
  })

  it('is undefined in an unpackaged run when ELECTRON_RENDERER_URL is unset or empty', () => {
    expect(devRendererUrl({}, false)).toBeUndefined()
    expect(devRendererUrl({ ELECTRON_RENDERER_URL: '' }, false)).toBeUndefined()
  })
})
