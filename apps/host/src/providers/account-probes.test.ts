import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { createAccountProbes } from './account-probes'

const h = vi.hoisted(() => ({ which: vi.fn(), probe: vi.fn(), print: vi.fn() }))
vi.mock('../machine/executables', () => ({ which: h.which }))
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: h.print }))
vi.mock('../machine/probe', () => ({ probe: h.probe }))

beforeEach(() => {
  vi.resetAllMocks()
  h.which.mockResolvedValue('/trusted/claude')
})

it('projects only named identity fields using the Host-owned binary and private account env', async () => {
  h.probe.mockResolvedValue({
    code: 0,
    stdout: '{"loggedIn":true,"email":"a@example.test","accessToken":"PRIVATE_TOKEN"}',
    stderr: '',
  })
  const probes = createAccountProbes({ home: '/host', env: { PATH: '/host/bin' } })
  const result = await probes.status('/ignored', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private' })
  expect(result).toMatchObject({
    binary: { found: true },
    auth: { ok: true, loggedIn: true, email: 'a@example.test' },
  })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN')
  expect(h.which).toHaveBeenCalledExactlyOnceWith('claude', '/host/bin')
  expect(h.probe).toHaveBeenCalledExactlyOnceWith('/trusted/claude', ['auth', 'status'], {
    env: { PATH: '/host/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private' },
    secrets: [],
    timeoutMs: 10_000,
  })
})

it('reports absent binaries and logout failure without projecting raw diagnostics', async () => {
  const probes = createAccountProbes({ home: '/host', env: {} })
  h.which.mockResolvedValue(null)
  expect((await probes.status()).binary).toEqual({ found: false })
  await expect(probes.logout()).rejects.toThrow('not installed')
  expect(h.probe).not.toHaveBeenCalled()
  h.which.mockResolvedValue('/trusted/claude')
  h.probe.mockResolvedValue({ code: 1, stdout: '', stderr: 'PRIVATE_TOKEN' })
  await expect(probes.logout()).rejects.toThrow('Could not sign out')
})

it('probes from a private temporary cwd with the selected account environment', async () => {
  const env = { HOME: '/host', PATH: '/host/bin' }
  const extraEnv = { CLAUDE_CONFIG_DIR: '/probe/b', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/slot/b' }
  let directory = ''
  h.print.mockImplementation((_file, _argv, { cwd }) => {
    directory = cwd
    expect(dirname(directory)).toBe(tmpdir())
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    return { stdout: '{"result":"Current session: 3% used"}' }
  })
  const probes = createAccountProbes({ home: env.HOME, env })
  expect((await probes.usage.fetchUsageSnapshot({ cacheKey: 'b', extraEnv })).ok).toBe(true)
  expect(h.print).toHaveBeenCalledExactlyOnceWith(
    '/trusted/claude',
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    expect.objectContaining({ cwd: directory, env: { ...env, ...extraEnv }, timeoutMs: 20_000 }),
  )
  expect(existsSync(directory)).toBe(false)
})

it('logs one bounded diagnostic per failed run, not the environment or output', async () => {
  const log = vi.fn()
  const options = { home: '/host', env: { HOME: '/host', PATH: '/secret/path' }, log }
  const { usage } = createAccountProbes(options)
  h.print.mockResolvedValue({ stdout: 'secret output', error: 'secret error', reason: 'timeout' })
  const read = () => usage.fetchUsageSnapshot({ cacheKey: 'b' })
  expect(await Promise.all([read(), read()])).toEqual(
    Array(2).fill({ ok: false, error: 'run-failed' }),
  )
  expect(log).toHaveBeenCalledExactlyOnceWith('host', 'claude.usage.failed', {
    accountId: 'b',
    reason: 'timeout',
    ms: expect.any(Number),
  })
})
