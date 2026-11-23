import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The order main.ts starts and stops its services in. Every module main.ts
// imports is stubbed and each stub appends its name to one log, so the test
// sees the sequence Electron would run after `app.whenReady` and after an
// approved quit. Paths are temporary; nothing touches the real userData.
const fake = vi.hoisted(() => {
  const calls: string[] = []
  const record =
    (name: string, result?: unknown) =>
    (..._args: unknown[]): unknown => {
      calls.push(name)
      return result
    }
  class FakeWindow {
    static created: FakeWindow[] = []
    static getAllWindows = (): FakeWindow[] => FakeWindow.open
    static open: FakeWindow[] = []
    loadURL = (): Promise<void> => Promise.resolve()
    loadFile = (): Promise<void> => Promise.resolve()
    on = (): void => {}
    isMinimized = (): boolean => false
    show = record('window.show')
    focus = record('window.focus')
    webContents = { on: () => {}, setWindowOpenHandler: () => {}, getURL: () => '' }
    constructor() {
      calls.push('createWindow')
      FakeWindow.created.push(this)
    }
  }
  return {
    calls,
    record,
    FakeWindow,
    packaged: true,
    userData: '/nonexistent/phosphor-startup-characterization/Phosphor',
    lockRequests: 0,
    appHandlers: new Map<string, (...args: unknown[]) => void>(),
    powerHandlers: new Map<string, unknown>(),
    background: [] as Array<() => void>,
    pauseAll: () => {},
    wakeRoutines: () => {},
    mode: 'in-app' as 'in-app' | 'daemon' | 'quit',
    /** A launch gate still deciding: resolve it to finish startup. */
    gate: undefined as Promise<'in-app' | 'daemon' | 'quit'> | undefined,
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return fake.packaged
    },
    setName: vi.fn(),
    getPath: () => fake.userData,
    getAppPath: () => '/nonexistent/phosphor-startup-characterization/app',
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    commandLine: {},
    requestSingleInstanceLock: () => {
      fake.lockRequests++
      return true
    },
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      fake.calls.push(`app.on:${event}`)
      fake.appHandlers.set(event, handler)
    },
    quit: fake.record('app.quit'),
    dock: undefined,
  },
  BrowserWindow: fake.FakeWindow,
  shell: { openExternal: vi.fn() },
  powerMonitor: {
    on: (event: string, handler: unknown) => {
      fake.calls.push(`powerMonitor.on:${event}`)
      fake.powerHandlers.set(event, handler)
    },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  protocol: { registerSchemesAsPrivileged: fake.record('registerSchemesAsPrivileged') },
}))
vi.mock('./routines', () => ({
  startRoutines: fake.record('startRoutines'),
  stopRoutines: fake.record('stopRoutines', Promise.resolve()),
  wakeRoutines: fake.wakeRoutines,
  routineScheduler: () => ({ pauseAll: fake.pauseAll }),
  hasPendingRoutineWork: () => false,
}))
vi.mock('./routines/background', () => ({
  installRoutineBackground: (open: () => void, pause: () => void) => {
    fake.calls.push('installRoutineBackground')
    fake.background = [open, pause]
  },
  routinesKeepRunning: () => false,
}))
vi.mock('./ipc', () => ({ registerIpcHandlers: fake.record('registerIpcHandlers') }))
vi.mock('./local-machine/launch', () => ({
  decideLocalRuntime: () => {
    fake.calls.push('decideLocalRuntime')
    return fake.gate ?? Promise.resolve(fake.mode)
  },
}))
vi.mock('./local-machine/launch-gate', () => ({
  quitLaunchGate: fake.record('quitLaunchGate', Promise.resolve()),
}))
vi.mock('./app/quit', () => ({ serviceLanesRunning: () => false, serviceQuitOptions: () => ({}) }))
vi.mock('./brain/runtime', () => ({ disposeBrain: fake.record('disposeBrain', Promise.resolve()) }))
vi.mock('./artifacts/artifact-sync', () => ({
  startArtifactSync: fake.record('startArtifactSync'),
}))
vi.mock('./feedback/feedback-service', () => ({ recordAppLaunch: fake.record('recordAppLaunch') }))
vi.mock('./maintenance/runtime', () => ({
  maintenanceScheduler: { start: fake.record('maintenanceScheduler.start') },
}))
vi.mock('./registry', () => ({
  registry: {
    list: () => [],
    get: () => undefined,
    disposeAll: fake.record('registry.disposeAll', Promise.resolve()),
    killAllSync: fake.record('registry.killAllSync'),
  },
}))
vi.mock('./pty/pty-manager', () => ({
  ptyManager: { size: 0, killAll: fake.record('ptyManager.killAll') },
}))
vi.mock('./pi/mcp-inspection', () => ({
  disposeMcpConnections: fake.record('disposeMcpConnections', Promise.resolve()),
}))
vi.mock('./pi/packages', () => ({
  disposePackageJobs: fake.record('disposePackageJobs', Promise.resolve()),
}))
vi.mock('./pi/session-launch', () => ({ preparePiConfig: fake.record('preparePiConfig') }))
vi.mock('./pi/login-flow', () => ({ cancelAllLogins: fake.record('cancelAllLogins') }))
vi.mock('./pi/claude-login', () => ({
  cancelAllClaudeLogins: fake.record('cancelAllClaudeLogins'),
}))
vi.mock('./pi/session-watcher', () => ({
  unwatchAll: fake.record('unwatchAll', Promise.resolve()),
}))
vi.mock('./fs/workspace-watcher', () => ({
  unwatchAllWorkspaces: fake.record('unwatchAllWorkspaces', Promise.resolve()),
}))
vi.mock('./account', () => ({ settleAccount: fake.record('settleAccount', Promise.resolve()) }))
vi.mock('./account/keyring', () => ({ configureLinuxKeyring: vi.fn() }))
vi.mock('./updates/updater', () => ({
  startUpdateChecks: fake.record('startUpdateChecks'),
  stopUpdateChecks: fake.record('stopUpdateChecks'),
}))
vi.mock('./window-chrome', () => ({
  applyThemeSource: fake.record('applyThemeSource'),
  applyZoom: vi.fn(),
  backgroundFor: () => '#000000',
  hideWindowsForE2E: () => false,
  overlayFor: () => ({}),
}))
vi.mock('./store', () => ({
  getPrefs: () => ({ theme: 'dark', fonts: { uiScale: 1 } }),
  getWritingPrefs: () => ({ spellcheck: true }),
}))
vi.mock('./writing/runtime', () => ({ applySpellcheck: fake.record('applySpellcheck') }))
vi.mock('./debug-log', () => ({ initDebugLog: fake.record('initDebugLog'), log: vi.fn() }))
vi.mock('./artifacts/artifact-protocol', () => ({
  artifactScheme: {},
  registerArtifactProtocol: fake.record('registerArtifactProtocol'),
}))
vi.mock('./fs/file-protocol', () => ({
  fileScheme: {},
  isFrameEscape: () => false,
  registerFileProtocol: fake.record('registerFileProtocol'),
}))
vi.mock('./external-links', () => ({ externalUrl: () => null, isAppNavigation: () => true }))
vi.mock('./voice/permissions', () => ({
  installPermissionPolicy: fake.record('installPermissionPolicy'),
}))
vi.mock('./dev-renderer-url', () => ({ devRendererUrl: () => undefined }))

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Loads main.ts once and lets its whenReady startup run. */
async function launchMain(testUserData?: string): Promise<void> {
  fake.calls.length = 0
  fake.appHandlers.clear()
  fake.powerHandlers.clear()
  fake.FakeWindow.created = []
  fake.FakeWindow.open = []
  fake.lockRequests = 0
  vi.stubEnv('PHOSPHOR_TEST_USER_DATA', testUserData)
  vi.resetModules()
  // main.ts installs signal and crash handlers; keep them out of this worker.
  const processOn = vi.spyOn(process, 'on').mockImplementation(() => process)
  try {
    await import('./main')
    await flush()
  } finally {
    processOn.mockRestore()
  }
}

let scratch: string | undefined
beforeEach(() => {
  fake.mode = 'in-app'
  fake.packaged = true
  fake.userData = '/nonexistent/phosphor-startup-characterization/Phosphor'
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('main.ts startup order', () => {
  it('starts services after ready in a fixed order', async () => {
    await launchMain()
    expect(fake.calls).toEqual([
      'registerSchemesAsPrivileged',
      'app.on:second-instance',
      'app.on:window-all-closed',
      'app.on:before-quit',
      'initDebugLog',
      'registerArtifactProtocol',
      'registerFileProtocol',
      'installPermissionPolicy',
      'applyThemeSource',
      'applySpellcheck',
      'registerIpcHandlers',
      // This Mac's runtime is decided before pi's config is prepared or anything starts.
      'decideLocalRuntime',
      'preparePiConfig',
      'startArtifactSync',
      'recordAppLaunch',
      'createWindow',
      'installRoutineBackground',
      'startRoutines',
      'powerMonitor.on:resume',
      'startUpdateChecks',
      'maintenanceScheduler.start',
      'app.on:activate',
    ])
    expect(fake.powerHandlers.get('resume')).toBe(fake.wakeRoutines)
  })

  it('in daemon mode starts no in-app runtime: no pi config, artifact sync or routines', async () => {
    fake.mode = 'daemon'
    await launchMain()
    expect(fake.calls).toEqual([
      'registerSchemesAsPrivileged',
      'app.on:second-instance',
      'app.on:window-all-closed',
      'app.on:before-quit',
      'initDebugLog',
      'registerArtifactProtocol',
      'registerFileProtocol',
      'installPermissionPolicy',
      'applyThemeSource',
      'applySpellcheck',
      'registerIpcHandlers',
      'decideLocalRuntime',
      'recordAppLaunch',
      'createWindow',
      'startUpdateChecks',
      'maintenanceScheduler.start',
      'app.on:activate',
    ])
  })

  it('a second launch while the runtime is undecided opens no window before it is decided', async () => {
    try {
      for (const outcome of ['daemon', 'quit'] as const) {
        let decide!: (mode: typeof outcome) => void
        fake.gate = new Promise((resolve) => (decide = resolve))
        await launchMain()
        fake.appHandlers.get('second-instance')!()
        await flush()
        expect(fake.calls).not.toContain('createWindow')
        decide(outcome)
        await flush()
        // Decided: the second launch focuses Phosphor. Quitting: it opens nothing.
        expect(fake.calls.includes('window.focus')).toBe(outcome === 'daemon')
        if (outcome === 'quit') expect(fake.calls).not.toContain('createWindow')
      }
    } finally {
      fake.gate = undefined
    }
  })

  it('a refused break-glass restore starts neither runtime nor a window', async () => {
    fake.mode = 'quit'
    await launchMain()
    expect(fake.calls.slice(fake.calls.indexOf('decideLocalRuntime'))).toEqual([
      'decideLocalRuntime',
    ])
  })

  it('wires the routine background to open a window and pause the scheduler', async () => {
    await launchMain()
    const [open, pause] = fake.background
    fake.calls.length = 0
    open!()
    expect(fake.calls).toEqual(['createWindow', 'window.show', 'window.focus'])
    fake.FakeWindow.open = [fake.FakeWindow.created[0]!]
    fake.calls.length = 0
    open!()
    expect(fake.calls).toEqual(['window.show', 'window.focus'])
    const pauseAll = vi.spyOn(fake, 'pauseAll')
    pause!()
    expect(pauseAll).toHaveBeenCalledTimes(1)
  })

  it('stops services on an approved quit in a fixed order, then quits', async () => {
    await launchMain()
    fake.calls.length = 0
    const beforeQuit = fake.appHandlers.get('before-quit')!
    const event = { preventDefault: vi.fn() }
    beforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalled()
    await flush()
    expect(fake.calls).toEqual([
      // A migration under way aborts before its commit point, or finishes after it.
      'quitLaunchGate',
      'stopUpdateChecks',
      'cancelAllLogins',
      'cancelAllClaudeLogins',
      'disposeMcpConnections',
      'disposePackageJobs',
      'ptyManager.killAll',
      'stopRoutines',
      'disposeBrain',
      'registry.disposeAll',
      'settleAccount',
      'unwatchAll',
      'unwatchAllWorkspaces',
      'app.quit',
    ])
    // The completed quit passes through rather than tearing down again.
    const second = { preventDefault: vi.fn() }
    beforeQuit(second)
    expect(second.preventDefault).not.toHaveBeenCalled()
  })

  it('takes the single-instance lock unless an unpackaged E2E run redirects userData', async () => {
    await launchMain()
    expect(fake.lockRequests).toBe(1)
    fake.packaged = false
    await launchMain('/nonexistent/phosphor-startup-characterization/e2e')
    expect(fake.lockRequests).toBe(0)
    fake.packaged = true
    await launchMain('/nonexistent/phosphor-startup-characterization/e2e')
    expect(fake.lockRequests).toBe(1)
  })

  it('adopts a legacy pidex userData folder only when Phosphor has none', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'phosphor-startup-'))
    fake.userData = join(scratch, 'Phosphor')
    mkdirSync(join(scratch, 'pidex'))
    await launchMain()
    expect(existsSync(join(scratch, 'Phosphor'))).toBe(true)
    expect(existsSync(join(scratch, 'pidex'))).toBe(false)
    mkdirSync(join(scratch, 'pidex'))
    await launchMain()
    expect(existsSync(join(scratch, 'pidex'))).toBe(true)
  })
})
