import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchCodexUsage } from './codex-usage'

const h = vi.hoisted(() => ({ exec: vi.fn(), health: vi.fn(), env: vi.fn(), stub: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: h.exec }))
vi.mock('node:util', () => ({ promisify: () => h.exec }))
vi.mock('./health', () => ({ checkPiHealth: h.health, cachedPiHealth: h.health }))
vi.mock('./shell-env', () => ({ piProcessEnv: h.env }))
vi.mock('./stub', () => ({ piStubPath: h.stub }))

beforeEach(() => {
  vi.clearAllMocks()
  h.stub.mockReturnValue(undefined)
  h.health.mockResolvedValue({ ok: true, binaryPath: '/node', prefixArgs: ['/pi.js'] })
  h.env.mockImplementation(async (extra) => ({ PATH: '/shell', ...extra }))
  h.exec.mockResolvedValue({ stdout: '{"status":"not_ready"}' })
})
afterEach(() => vi.restoreAllMocks())

it('reads credentials with fixed argv, a 64KiB bound and 15-second timeout', async () => {
  expect(await fetchCodexUsage()).toEqual({ ok: false, error: 'auth-unavailable' })
  expect(h.exec).toHaveBeenCalledWith(
    '/node',
    [
      '/pi.js',
      'auth',
      'check',
      '--provider',
      'openai-codex',
      '--json',
      '--credentials',
      '--no-refresh',
    ],
    { env: { PATH: '/shell' }, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
  )
})

it('stub credentials retain the shell-aware environment and Electron-as-Node overlay', async () => {
  h.stub.mockReturnValue('/stub.cjs')
  await fetchCodexUsage()
  expect(h.exec).toHaveBeenCalledWith(
    process.execPath,
    [
      '/stub.cjs',
      'auth',
      'check',
      '--provider',
      'openai-codex',
      '--json',
      '--credentials',
      '--no-refresh',
    ],
    expect.objectContaining({ env: { PATH: '/shell', ELECTRON_RUN_AS_NODE: '1' } }),
  )
  expect(h.health).not.toHaveBeenCalled()
})

it('never logs or returns captured credentials on subprocess failure', async () => {
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
  h.exec.mockRejectedValue(Object.assign(new Error('SECRET stderr'), { stdout: 'SECRET token' }))
  expect(await fetchCodexUsage()).toEqual({ ok: false, error: 'auth-unavailable' })
  for (const log of logs) expect(log).not.toHaveBeenCalled()
})

it('does not spawn when pi is unavailable', async () => {
  h.health.mockResolvedValue({ ok: false })
  expect(await fetchCodexUsage()).toEqual({ ok: false, error: 'auth-unavailable' })
  expect(h.exec).not.toHaveBeenCalled()
})
