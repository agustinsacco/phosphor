import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// main.ts's quit path and package jobs: an approved quit must stop every
// package job (its own process tree, outside the session registry) before
// Electron is told to quit, and a cancelled quit must leave them running.
// Every module main.ts imports is stubbed except the shutdown approval, whose
// real decision is what is under test; startup never runs (whenReady never
// resolves), so only the quit wiring is observed.
const fake = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  processHandlers: new Map<string, (...args: unknown[]) => void>(),
  quit: (): void => {},
  disposePackageJobs: (): Promise<void> => Promise.resolve(),
  dialogResponse: 1,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    setName: vi.fn(),
    getPath: () => '/nonexistent/phosphor-package-quit-test/userData',
    getAppPath: () => '/nonexistent/phosphor-package-quit-test/app',
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    commandLine: {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      fake.appHandlers.set(event, handler)
    },
    quit: () => fake.quit(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn() },
  dialog: { showMessageBox: async () => ({ response: fake.dialogResponse }) },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))
vi.mock('./packages', () => ({ disposePackageJobs: () => fake.disposePackageJobs() }))
vi.mock('../routines', () => ({
  startRoutines: vi.fn(),
  stopRoutines: () => Promise.resolve(),
  wakeRoutines: vi.fn(),
  routineScheduler: vi.fn(),
  hasPendingRoutineWork: () => false,
}))
vi.mock('../routines/background', () => ({
  installRoutineBackground: vi.fn(),
  routinesKeepRunning: () => false,
}))
vi.mock('../ipc', () => ({ registerIpcHandlers: vi.fn() }))
vi.mock('../artifacts/artifact-sync', () => ({ startArtifactSync: vi.fn() }))
vi.mock('../feedback/feedback-service', () => ({ recordAppLaunch: vi.fn() }))
vi.mock('../maintenance/runtime', () => ({ maintenanceScheduler: { start: vi.fn() } }))
vi.mock('../registry', () => ({
  registry: {
    list: () => [],
    get: () => undefined,
    disposeAll: () => Promise.resolve(),
    killAllSync: vi.fn(),
  },
}))
// A live terminal is unconfirmed work, so every quit here asks first.
vi.mock('../pty/pty-manager', () => ({ ptyManager: { size: 1, killAll: vi.fn() } }))
vi.mock('./mcp-cli', () => ({ disposeMcpLogins: vi.fn() }))
vi.mock('./session-launch', () => ({ ensureDesktopArtifactSkill: vi.fn() }))
vi.mock('./login-flow', () => ({ cancelAllLogins: vi.fn() }))
vi.mock('./claude-login', () => ({ cancelAllClaudeLogins: vi.fn() }))
vi.mock('./session-watcher', () => ({ unwatchAll: () => Promise.resolve() }))
vi.mock('../fs/workspace-watcher', () => ({ unwatchAllWorkspaces: () => Promise.resolve() }))
vi.mock('../account', () => ({ settleAccount: () => Promise.resolve() }))
vi.mock('../account/keyring', () => ({ configureLinuxKeyring: vi.fn() }))
vi.mock('../updates/updater', () => ({ startUpdateChecks: vi.fn(), stopUpdateChecks: vi.fn() }))
vi.mock('../window-chrome', () => ({
  applyThemeSource: vi.fn(),
  applyZoom: vi.fn(),
  backgroundFor: () => '#000000',
  hideWindowsForE2E: () => false,
  overlayFor: () => ({}),
}))
vi.mock('../store', () => ({
  getPrefs: () => ({ theme: 'dark', fonts: { uiScale: 1 } }),
  getWritingPrefs: () => ({ spellcheck: true }),
}))
vi.mock('../writing/runtime', () => ({ applySpellcheck: vi.fn() }))
vi.mock('../debug-log', () => ({ initDebugLog: vi.fn(), log: vi.fn() }))
vi.mock('../artifacts/artifact-protocol', () => ({
  artifactScheme: {},
  registerArtifactProtocol: vi.fn(),
}))
vi.mock('../fs/file-protocol', () => ({
  fileScheme: {},
  isFrameEscape: () => false,
  registerFileProtocol: vi.fn(),
}))
vi.mock('../external-links', () => ({ externalUrl: () => null, isAppNavigation: () => true }))
vi.mock('../voice/permissions', () => ({ installPermissionPolicy: vi.fn() }))
vi.mock('../dev-renderer-url', () => ({ devRendererUrl: () => undefined }))

const quit = vi.fn()
const disposePackageJobs = vi.fn(() => Promise.resolve())

/** Loads main.ts once, capturing its app and process handlers. */
async function loadMain(): Promise<void> {
  fake.appHandlers.clear()
  fake.processHandlers.clear()
  fake.quit = quit
  fake.disposePackageJobs = disposePackageJobs
  vi.stubEnv('PHOSPHOR_TEST_USER_DATA', undefined)
  vi.resetModules()
  // main.ts installs signal and crash handlers; keep them out of this worker.
  const processOn = vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    fake.processHandlers.set(event, handler)
    return process
  }) as typeof process.on)
  try {
    await import('../main')
  } finally {
    processOn.mockRestore()
  }
}

/** Fire Electron's before-quit the way a Cmd-Q would. */
function requestQuit(): void {
  const beforeQuit = fake.appHandlers.get('before-quit')
  if (!beforeQuit) throw new Error('main.ts registered no before-quit handler')
  beforeQuit({ preventDefault: vi.fn() })
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  quit.mockReset()
  disposePackageJobs.mockReset()
  disposePackageJobs.mockImplementation(() => Promise.resolve())
  fake.dialogResponse = 1
  await loadMain()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('quit and package jobs', () => {
  it('an approved quit stops package jobs before Electron quits', async () => {
    requestQuit()
    await flush()

    expect(disposePackageJobs).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(disposePackageJobs.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    )
  })

  it('a cancelled quit leaves package jobs running', async () => {
    fake.dialogResponse = 0
    requestQuit()
    await flush()

    expect(disposePackageJobs).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quit waits for package jobs to settle, then quits', async () => {
    let settle: () => void = () => {}
    disposePackageJobs.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    requestQuit()
    await flush()
    expect(disposePackageJobs).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()

    settle()
    await flush()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('quit still completes when package job settlement fails', async () => {
    disposePackageJobs.mockImplementation(() => Promise.reject(new Error('stuck')))
    requestQuit()
    await flush()

    expect(disposePackageJobs).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('a signal shutdown stops package jobs too', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const onSigterm = fake.processHandlers.get('SIGTERM')
    if (!onSigterm) throw new Error('main.ts registered no SIGTERM handler')

    onSigterm()

    expect(disposePackageJobs).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
