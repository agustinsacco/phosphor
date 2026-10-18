import { beforeEach, expect, it, vi } from 'vitest'
import { createAccountProbes } from './account-probes'

const h = vi.hoisted(() => ({ which: vi.fn(), probe: vi.fn() }))
vi.mock('../machine/executables', () => ({ which: h.which }))
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
