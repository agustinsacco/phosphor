import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@shared/models'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  binary: '/first/pi',
  version: vi.fn(async () => ({ stdout: '1.2.0', stderr: '' })),
  print: vi.fn(async () => ({ stdout: 'Fix Login Bug', error: undefined })),
  environment: vi.fn(async () => ({ PATH: '/shell/bin' })),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo/apps/desktop', getPath: () => '/data' },
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: h.version,
  }),
}))
vi.mock('../pi/binary-lookup', () => ({
  lookupPosixBinary: async () => h.binary,
  windowsWhereOutput: async () => '',
}))
vi.mock('../pi/win-launch', () => ({
  resolveWindowsLaunch: async () => ({ ok: true, launch: { file: h.binary, prefixArgs: [] } }),
}))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: h.environment }))
vi.mock('./handle', () => ({
  handle: (name: string, callback: (...args: unknown[]) => unknown) =>
    h.handlers.set(name, callback),
}))
vi.mock('./hosts-handlers', () => ({ remoteLanes: vi.fn() }))
vi.mock('../pi/session-runtime', () => ({
  desktopSessions: {
    create: async () => (await import('../pi/session-launch')).prepareDesktopSessionLaunch(),
  },
}))
vi.mock('../pi/print-mode', () => ({ runPrintMode: h.print }))
vi.mock('./pi-config-handlers', () => ({ catalogueModels: async () => [] }))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({
  readAgentSettings: async () => ({ defaultProvider: 'openai' }),
}))
vi.mock('../claude/accounts', () => ({ claudeAccountEnv: () => ({}), primaryAccount: vi.fn() }))
vi.mock('../store', () => ({
  getLanePrefs: () => ({ nameMinWords: 2, nameMaxWords: 5, nameMaxLength: 60 }),
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args)
const session = () => call('pi:createSession', { workspacePath: '/repo' })
const title = () => call('pi:generateTitle', '/repo', 'fix login', [])

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('PHOSPHOR_PI_STUB', '')
  h.binary = '/first/pi'
  h.version.mockResolvedValue({ stdout: MIN_PI_VERSION, stderr: '' })
  h.print.mockResolvedValue({ stdout: 'Fix Login Bug', error: undefined })
  h.handlers.clear()
  ;(await import('./pi-session-handlers')).registerPiSessionHandlers()
})
afterEach(() => vi.unstubAllEnvs())

it('reports the stub script and minimum version without probing pi', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
  expect(await call('pi:health')).toEqual({
    ok: true,
    binaryPath: '/stub.cjs',
    version: MIN_PI_VERSION,
    minVersion: MIN_PI_VERSION,
  })
  expect(h.version).not.toHaveBeenCalled()
})

it('retries unhealthy health IPC probes instead of caching failures', async () => {
  h.version.mockResolvedValueOnce({ stdout: '0.1.0', stderr: '' })
  expect(await call('pi:health')).toMatchObject({ ok: false, reason: 'too-old' })
  expect(await call('pi:health')).toMatchObject({ ok: true, binaryPath: '/first/pi' })
  expect(h.version).toHaveBeenCalledTimes(2)
})

it('preserves a session health failure and retries its next launch', async () => {
  h.version.mockResolvedValueOnce({ stdout: '0.1.0', stderr: '' })
  await expect(session()).rejects.toThrow('older than the minimum supported')
  expect(await session()).toMatchObject({ binaryPath: '/first/pi' })
  expect(h.version).toHaveBeenCalledTimes(2)
})

it('returns null for an unhealthy title run without spawning print mode', async () => {
  h.version.mockResolvedValueOnce({ stdout: '0.1.0', stderr: '' })
  expect(await title()).toBeNull()
  expect(h.print).not.toHaveBeenCalled()
  expect(await title()).toBe('Fix Login Bug')
})

it('keeps title provider and one-shot overlays on the login-shell environment', async () => {
  expect(await title()).toBe('Fix Login Bug')
  expect(h.print).toHaveBeenCalledWith('/first/pi', expect.any(Array), {
    cwd: '/repo',
    env: expect.objectContaining({
      PATH: '/shell/bin',
      PI_CLAUDE_CLI_CONTEXT: 'pi',
      PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
      PI_CLAUDE_CLI_EPHEMERAL: '1',
    }),
  })
})

it('keeps stub titles on the inherited environment without provider overlays', async () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
  vi.stubEnv('DM03_INHERITED', 'kept')
  expect(await title()).toBe('Fix Login Bug')
  expect(h.print).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['/stub.cjs']), {
    cwd: '/repo',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  expect(h.version).not.toHaveBeenCalled()
  expect(h.environment).not.toHaveBeenCalled()
})

it('shares a single health probe across health IPC, session launches and titles', async () => {
  await call('pi:health')
  await session()
  await title()
  expect(h.version).toHaveBeenCalledTimes(1)
})

it('uses the newly discovered executable for health IPC after invalidation', async () => {
  await call('pi:health')
  h.binary = '/replacement/pi'
  ;(await import('../pi/health')).invalidatePiHealth()
  expect(await call('pi:health')).toMatchObject({ binaryPath: '/replacement/pi' })
})

it('uses the newly discovered executable for sessions after invalidation', async () => {
  await session()
  h.binary = '/replacement/pi'
  ;(await import('../pi/health')).invalidatePiHealth()
  expect(await session()).toMatchObject({ binaryPath: '/replacement/pi' })
})

it('uses the newly discovered executable for titles after invalidation', async () => {
  await title()
  h.binary = '/replacement/pi'
  ;(await import('../pi/health')).invalidatePiHealth()
  await title()
  expect(h.print).toHaveBeenLastCalledWith('/replacement/pi', expect.any(Array), expect.any(Object))
})

it('expires the shared healthy result after the health TTL', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  try {
    vi.resetModules()
    ;(await import('./pi-session-handlers')).registerPiSessionHandlers()
    await call('pi:health')
    h.binary = '/replacement/pi'
    now.mockReturnValue(1_000 + 5 * 60_000)
    expect(await session()).toMatchObject({ binaryPath: '/replacement/pi' })
    expect(await call('pi:health')).toMatchObject({ binaryPath: '/replacement/pi' })
    expect(h.version).toHaveBeenCalledTimes(2)
  } finally {
    now.mockRestore()
  }
})

it('deduplicates concurrent consumers before and after invalidation', async () => {
  await Promise.all([call('pi:health'), session(), title()])
  expect(h.version).toHaveBeenCalledTimes(1)
  h.binary = '/replacement/pi'
  ;(await import('../pi/health')).invalidatePiHealth()
  const [health, launch] = await Promise.all([call('pi:health'), session(), title()])
  expect(health).toMatchObject({ binaryPath: '/replacement/pi' })
  expect(launch).toMatchObject({ binaryPath: '/replacement/pi' })
  expect(h.version).toHaveBeenCalledTimes(2)
})
