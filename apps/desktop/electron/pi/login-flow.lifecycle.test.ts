import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LoginFlowState } from '@shared/models'
import type { AuthCheck } from '@phosphor/session-runtime/pi/provider-auth'
import { checkProviderAuth } from './auth-status'
import { checkPiHealth, piArgs } from './health'
import { ptyManager } from '../pty/pty-manager'
import { log } from '../debug-log'
import { cancelAllLogins, cancelLogin, loginInFlight, startLogin } from './login-flow'

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/test/user-data' } }))
vi.mock('./health', () => ({ checkPiHealth: vi.fn(), piArgs: vi.fn() }))
vi.mock('./shell-env', () => ({ piProcessEnv: async () => ({ PATH: '/test/bin' }) }))
vi.mock('./auth-status', () => ({ checkProviderAuth: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../pty/pty-manager', () => ({
  ptyManager: { create: vi.fn(), attach: vi.fn(), write: vi.fn(), kill: vi.fn() },
}))

const states: LoginFlowState[] = []
const old: AuthCheck = { status: 'ready', fingerprint: 'old' }
const fresh: AuthCheck = { status: 'ready', fingerprint: 'fresh' }
const browser = 'https://example.com/oauth/authorize\nCmd+click to open'
let screen = ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.resetAllMocks()
  states.length = 0
  screen = ''
  vi.mocked(checkPiHealth).mockResolvedValue({
    ok: true,
    binaryPath: '/test/pi',
    minVersion: '0.84.1',
  })
  vi.mocked(piArgs).mockImplementation((_health, args) => ['pi-prefix', ...args])
  vi.mocked(checkProviderAuth).mockResolvedValue(old)
  vi.mocked(ptyManager.create).mockReturnValue({ ptyId: 'login-pty' })
  vi.mocked(ptyManager.attach).mockImplementation(() => ({ scrollback: screen }))
})
afterEach(() => {
  cancelAllLogins()
  vi.useRealTimers()
})

const start = () => startLogin('openai-codex', (state) => states.push(state))
async function paint(text: string, elapsed = 250): Promise<void> {
  screen = text
  await vi.advanceTimersByTimeAsync(elapsed)
}
async function reachBrowser(): Promise<void> {
  await paint('› Describe a task')
  await paint('Select authentication method:')
  await paint('Select provider to configure:')
  await paint('Browser login', 500)
  await paint(browser)
}
function deferred() {
  let resolve!: (value: AuthCheck) => void
  const promise = new Promise<AuthCheck>((done) => (resolve = done))
  return { promise, resolve }
}

it('drives the full TUI sequence once and preserves spawn arguments and provider Enter delay', async () => {
  await start()
  expect(ptyManager.create).toHaveBeenCalledWith(
    '/test/user-data/pi-sign-in',
    1000,
    40,
    undefined,
    {
      file: '/test/pi',
      args: ['pi-prefix', '--no-session', '--no-approve', '--no-extensions'],
      env: { PATH: '/test/bin' },
    },
  )
  expect(checkProviderAuth).toHaveBeenCalledBefore(vi.mocked(ptyManager.create))
  await paint('› Describe a task')
  await paint('Select authentication method:')
  await paint('Select authentication method:')
  await paint('Select provider to configure:')
  expect(vi.mocked(ptyManager.write).mock.calls.map((call) => call[1])).toEqual([
    '/login\r',
    '\r',
    'OpenAI Codex',
  ])
  await vi.advanceTimersByTimeAsync(399)
  expect(ptyManager.write).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(ptyManager.write).toHaveBeenLastCalledWith('login-pty', '\r')
  await paint('Select provider to configure:\nBrowser login')
  await paint('GitHub Enterprise URL/domain')
  await paint(`${browser}\nEnter code: ABCD-1234`)
  await paint(`${browser}\nEnter code: ABCD-1234`, 2500)
  expect(vi.mocked(ptyManager.write).mock.calls.map((call) => call[1])).toEqual([
    '/login\r',
    '\r',
    'OpenAI Codex',
    '\r',
    '\r',
    '\r',
  ])
  expect(states).toEqual([
    { providerId: 'openai-codex', phase: 'starting' },
    { providerId: 'openai-codex', phase: 'starting' },
    {
      providerId: 'openai-codex',
      phase: 'awaiting-browser',
      url: 'https://example.com/oauth/authorize',
      userCode: 'ABCD-1234',
    },
  ])
  expect(ptyManager.kill).not.toHaveBeenCalled()
})

it('does not accept the old credential and throttles verification to two seconds', async () => {
  await start()
  await reachBrowser()
  expect(checkProviderAuth).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1750)
  expect(checkProviderAuth).toHaveBeenCalledTimes(2)
  vi.mocked(checkProviderAuth).mockResolvedValue(fresh)
  await vi.advanceTimersByTimeAsync(250)
  expect(checkProviderAuth).toHaveBeenCalledTimes(3)
  expect(states.at(-1)).toEqual({ providerId: 'openai-codex', phase: 'signed-in' })
  expect(loginInFlight('openai-codex')).toBe(false)
  expect(ptyManager.kill).toHaveBeenCalledExactlyOnceWith('login-pty')
  await vi.advanceTimersByTimeAsync(5000)
  expect(checkProviderAuth).toHaveBeenCalledTimes(3)
})

it('serializes verification and retries transient failures', async () => {
  await start()
  const pending = deferred()
  vi.mocked(checkProviderAuth).mockReturnValueOnce(pending.promise)
  await reachBrowser()
  await vi.advanceTimersByTimeAsync(6000)
  expect(checkProviderAuth).toHaveBeenCalledTimes(2)
  pending.resolve(old)
  await vi.advanceTimersByTimeAsync(250)
  expect(checkProviderAuth).toHaveBeenCalledTimes(3)
  vi.mocked(checkProviderAuth).mockRejectedValueOnce(new Error('transient'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(ptyManager.kill).not.toHaveBeenCalled()
  vi.mocked(checkProviderAuth).mockResolvedValue(fresh)
  await vi.advanceTimersByTimeAsync(2000)
  expect(states.at(-1)?.phase).toBe('signed-in')
})

it('ignores late verification after cancellation and sends Escape before killing', async () => {
  const handle = await start()
  const pending = deferred()
  vi.mocked(checkProviderAuth).mockReturnValueOnce(pending.promise)
  await reachBrowser()
  handle.cancel()
  expect(ptyManager.write).toHaveBeenLastCalledWith('login-pty', '\u001b')
  expect(ptyManager.write).toHaveBeenCalledBefore(vi.mocked(ptyManager.kill))
  expect(states.at(-1)).toEqual({ providerId: 'openai-codex', phase: 'cancelled' })
  pending.resolve(fresh)
  await vi.advanceTimersByTimeAsync(5000)
  handle.cancel()
  expect(states.filter((state) => state.phase === 'signed-in')).toEqual([])
  expect(ptyManager.kill).toHaveBeenCalledTimes(1)
})

it('cancels safely when Escape cannot be written and suppresses delayed provider Enter', async () => {
  await start()
  await paint('›')
  await paint('Select authentication method:')
  await paint('Select provider to configure:')
  vi.mocked(ptyManager.write).mockImplementationOnce(() => {
    throw new Error('gone')
  })
  cancelLogin('openai-codex')
  const writes = vi.mocked(ptyManager.write).mock.calls.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(ptyManager.write).toHaveBeenCalledTimes(writes)
  expect(ptyManager.kill).toHaveBeenCalledTimes(1)
})

it('fails an unknown screen only after the step budget and logs its tail', async () => {
  await start()
  await paint('startup dialog', 20_000)
  expect(ptyManager.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(states.at(-1)?.phase).toBe('error')
  expect(
    states.map((state) => (state.phase === 'error' ? state.message : undefined)).at(-1),
  ).toMatch(/stopped at a screen/)
  expect(log).toHaveBeenCalledWith(
    'login',
    'sign-in stopped at an unknown screen',
    expect.objectContaining({ screen: 'startup dialog', step: 'unknown' }),
  )
  expect(loginInFlight('openai-codex')).toBe(false)
})

it('enforces the separate setup budget before processing a late screen', async () => {
  await start()
  vi.setSystemTime(Date.now() + 120_000)
  await paint('›')
  expect(ptyManager.write).not.toHaveBeenCalled()
  expect(
    states.map((state) => (state.phase === 'error' ? state.message : undefined)).at(-1),
  ).toMatch(/did not reach a sign-in page/)
  expect(ptyManager.kill).toHaveBeenCalledTimes(1)
})

it('keeps the callback alive for fifteen minutes from the URL without repaint extensions', async () => {
  await start()
  await reachBrowser()
  await vi.advanceTimersByTimeAsync(900_000)
  expect(ptyManager.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(
    states.map((state) => (state.phase === 'error' ? state.message : undefined)).at(-1),
  ).toMatch(/closed pi’s callback server/)
  expect(ptyManager.kill).toHaveBeenCalledTimes(1)
})

it('restarts the browser budget for a changed authorization prompt', async () => {
  await start()
  await reachBrowser()
  await vi.advanceTimersByTimeAsync(800_000)
  await paint('https://example.com/oauth/new\nCmd+click to open')
  await vi.advanceTimersByTimeAsync(200_000)
  expect(ptyManager.kill).not.toHaveBeenCalled()
  expect(states.filter((state) => state.phase === 'awaiting-browser')).toHaveLength(2)
})

it('ignores verification that resolves after the browser budget expires', async () => {
  await start()
  const pending = deferred()
  vi.mocked(checkProviderAuth).mockReturnValueOnce(pending.promise)
  await reachBrowser()
  await vi.advanceTimersByTimeAsync(900_250)
  pending.resolve(fresh)
  await vi.advanceTimersByTimeAsync(250)
  expect(states.at(-1)?.phase).toBe('error')
  expect(ptyManager.kill).toHaveBeenCalledTimes(1)
})

it('tracks independent providers, refuses a duplicate and cancels all attempts', async () => {
  await start()
  await expect(start()).rejects.toThrow('already in progress')
  await startLogin('xai', (state) => states.push(state))
  expect(loginInFlight('openai-codex')).toBe(true)
  expect(loginInFlight('xai')).toBe(true)
  cancelAllLogins()
  expect(loginInFlight('openai-codex')).toBe(false)
  expect(loginInFlight('xai')).toBe(false)
  expect(states.slice(-2).map((state) => state.phase)).toEqual(['cancelled', 'cancelled'])
})

it('reports missing pi without spawning a PTY', async () => {
  vi.mocked(checkPiHealth).mockResolvedValue({
    ok: false,
    message: 'missing pi',
    minVersion: '0.84.1',
  })
  await expect(start()).rejects.toThrow('missing pi')
  expect(ptyManager.create).not.toHaveBeenCalled()
  expect(loginInFlight('openai-codex')).toBe(false)
})
