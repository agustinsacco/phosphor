import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  catalogue: vi.fn(),
  run: vi.fn(),
  settings: vi.fn(),
  packages: vi.fn(),
  account: vi.fn(),
  health: vi.fn(),
  stub: undefined as string | undefined,
  prefs: { nameMinWords: 2, nameMaxWords: 5, nameMaxLength: 60 },
}))
vi.mock('./handle', () => ({
  handle: (name: string, callback: (...args: unknown[]) => unknown) =>
    state.handlers.set(name, callback),
}))
vi.mock('./hosts-handlers', () => ({ remoteLanes: vi.fn() }))
vi.mock('../pi/session-runtime', () => ({ desktopSessions: {} }))
vi.mock('../pi/health', () => ({ cachedPiHealth: state.health }))
vi.mock('../pi/stub', () => ({ piStubPath: () => state.stub }))
vi.mock('../pi/shell-env', () => ({
  piProcessEnv: async () => ({ PATH: '/pi/bin', PI_CLAUDE_CLI_KEEPALIVE_MS: '999' }),
}))
vi.mock('./pi-config-handlers', () => ({ catalogueModels: state.catalogue }))
vi.mock('../pi/catalogue', () => ({ catalogueModels: state.catalogue }))
vi.mock('../pi/print-mode', () => ({ runPrintMode: state.run }))
vi.mock('@phosphor/session-runtime/pi/agent-settings', () => ({
  readAgentSettings: state.settings,
}))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: state.packages }))
vi.mock('@phosphor/session-runtime/pi/package-resources', () => ({
  resolvePackagePaths: () => ({ extensions: ['/pkg/provider/index.ts'] }),
}))
vi.mock('../claude/accounts', () => ({
  primaryAccount: state.account,
  claudeAccountEnv: (account: { credentialDir: string } | null) =>
    account ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: account.credentialDir } : {},
}))
vi.mock('../store', () => ({ getLanePrefs: () => state.prefs }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

const generate = (names: string[] = []) =>
  state.handlers.get('pi:generateTitle')!({}, '/repo', 'fix login', names)
const args = (index: number): string[] => state.run.mock.calls[index]![1]
const model = (id: string, cost: number) => ({
  provider: 'vendor',
  id,
  cost: { input: cost, output: cost },
})

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  state.stub = undefined
  state.prefs = { nameMinWords: 2, nameMaxWords: 5, nameMaxLength: 60 }
  state.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi', prefixArgs: ['entry.js'] })
  state.catalogue.mockResolvedValue([])
  state.settings.mockResolvedValue({ defaultProvider: 'vendor' })
  state.packages.mockResolvedValue([])
  state.account.mockResolvedValue(null)
  state.run.mockResolvedValue({ stdout: 'Fix Login Bug' })
  const { registerPiSessionHandlers } = await import('./pi-session-handlers')
  registerPiSessionHandlers()
})
afterEach(() => vi.useRealTimers())

it('waits four seconds for a cold catalogue then uses the default', async () => {
  vi.useFakeTimers()
  state.catalogue.mockReturnValue(new Promise(() => {}))
  const result = generate()
  await vi.advanceTimersByTimeAsync(3999)
  expect(state.run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toBe('Fix Login Bug')
  expect(args(0)).not.toContain('--model')
  expect(args(0)).toContain('--no-extensions')
})

it('stops retries after a timeout with no stdout', async () => {
  state.run.mockResolvedValue({ stdout: '', error: 'timed out after 30000ms' })
  expect(await generate()).toBeNull()
  expect(state.run).toHaveBeenCalledTimes(1)
})

it('returns null after all attempts fail and does not learn from total failure', async () => {
  state.run.mockResolvedValue({ stdout: '', error: 'offline' })
  expect(await generate()).toBeNull()
  expect(await generate()).toBeNull()
  expect(state.run).toHaveBeenCalledTimes(4)
  expect(args(0)).toEqual(args(2))
  expect(args(1)).toEqual(args(3))
})

it('learns to fully boot a provider only after full boot succeeds', async () => {
  state.run.mockResolvedValueOnce({ stdout: '', error: 'Unknown provider' })
  expect(await generate()).toBe('Fix Login Bug')
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.run).toHaveBeenCalledTimes(3)
  expect(args(0)).toContain('--no-extensions')
  expect(args(1)).not.toContain('--no-extensions')
  expect(args(2)).not.toContain('--no-extensions')
})

it('learns an unusable picked model after the fallback succeeds', async () => {
  state.settings.mockResolvedValue({ defaultProvider: 'vendor', defaultModel: 'chat-large' })
  state.catalogue.mockResolvedValue([model('chat-large', 10), model('chat-small', 1)])
  state.run
    .mockResolvedValueOnce({ stdout: '', error: 'model denied' })
    .mockResolvedValueOnce({ stdout: '', error: 'model denied' })
  expect(await generate()).toBe('Fix Login Bug')
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.run).toHaveBeenCalledTimes(4)
  expect(args(0)).toContain('chat-small')
  expect(args(1)).toContain('chat-small')
  expect(args(2)).not.toContain('--model')
  expect(args(3)).not.toContain('--model')
  expect(args(3)).toContain('--no-extensions')
})

it('sanitizes, caps length then deduplicates and honors word preferences', async () => {
  state.prefs = { nameMinWords: 3, nameMaxWords: 7, nameMaxLength: 9 }
  state.run.mockResolvedValue({ stdout: 'Here is a title:\n"Fix Login Bug."\n' })
  expect(await generate(['fix login', 'Fix Login 2'])).toBe('Fix Login 3')
  expect(args(0).at(-1)).toContain('3-7 words')
  expect(args(0).at(-1)).toContain('- fix login\n- Fix Login 2')
})

it('carries invoker argv, Claude account, one-shot env and executable extension paths', async () => {
  state.settings.mockResolvedValue({ defaultProvider: 'pi-claude-cli' })
  state.packages.mockResolvedValue([
    { name: '@saccolabs/pi-claude-cli', installed: true, installPath: '/pkg/provider' },
  ])
  state.account.mockResolvedValue({ credentialDir: '/accounts/pinned' })
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.run).toHaveBeenCalledWith(
    '/bin/pi',
    expect.arrayContaining([
      'entry.js',
      '-p',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '-e',
      '/pkg/provider/index.ts',
      '--model',
      'claude-haiku-4-5',
    ]),
    expect.objectContaining({
      cwd: '/repo',
      env: expect.objectContaining({
        PATH: '/pi/bin',
        PI_CLAUDE_CLI_CONTEXT: 'pi',
        PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
        PI_CLAUDE_CLI_EPHEMERAL: '1',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/pinned',
      }),
    }),
  )
  expect(state.account).toHaveBeenCalledOnce()
})

it('uses full boot for Claude when no installed provider paths are available', async () => {
  state.settings.mockResolvedValue({ defaultProvider: 'pi-claude-cli' })
  state.account.mockRejectedValue(new Error('signed out'))
  expect(await generate()).toBe('Fix Login Bug')
  expect(args(0)).not.toContain('--no-extensions')
  expect(args(0)).not.toContain('-e')
})

it('skips catalogue, settings and account discovery for the inherited stub', async () => {
  state.stub = '/stub.cjs'
  expect(await generate()).toBe('Fix Login Bug')
  expect(state.catalogue).not.toHaveBeenCalled()
  expect(state.settings).not.toHaveBeenCalled()
  expect(state.account).not.toHaveBeenCalled()
  expect(state.run.mock.calls[0]![0]).toBe(process.execPath)
  expect(args(0)[0]).toBe('/stub.cjs')
  expect(args(0)).not.toContain('--no-extensions')
  expect(state.run.mock.calls[0]![2].env.ELECTRON_RUN_AS_NODE).toBe('1')
})

it('returns null without a subprocess when pi is unavailable', async () => {
  state.health.mockResolvedValue({ ok: false })
  expect(await generate()).toBeNull()
  expect(state.run).not.toHaveBeenCalled()
})
