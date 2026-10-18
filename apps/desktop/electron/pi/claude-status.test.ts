import { beforeEach, expect, it, vi } from 'vitest'
import { claudeStatus, parseClaudeAuthStatus } from './claude-status'

const h = vi.hoisted(() => ({ exec: vi.fn(), lookup: vi.fn(), env: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: h.exec }))
vi.mock('node:util', () => ({ promisify: () => h.exec }))
vi.mock('./binary-lookup', () => ({ resolveBinary: h.lookup }))
vi.mock('./shell-env', () => ({ piProcessEnv: h.env }))
beforeEach(() => {
  vi.clearAllMocks()
  h.lookup.mockResolvedValue('/claude')
  h.env.mockResolvedValue({ PATH: '/shell', CLAUDE_CONFIG_DIR: '/default' })
  h.exec.mockResolvedValue({ stdout: '{"loggedIn":true}' })
})

it('version failure is cosmetic and account environment scopes both subprocesses', async () => {
  h.exec.mockRejectedValueOnce(new Error('version failed'))
  const result = await claudeStatus('/override', { CLAUDE_CONFIG_DIR: '/account' })
  expect(result).toEqual({
    binary: { found: true, path: '/override', version: undefined },
    auth: { ok: true, loggedIn: true },
  })
  expect(h.exec.mock.calls).toEqual([
    [
      '/override',
      ['--version'],
      { timeout: 10_000, env: { PATH: '/shell', CLAUDE_CONFIG_DIR: '/account' } },
    ],
    [
      '/override',
      ['auth', 'status'],
      { timeout: 10_000, env: { PATH: '/shell', CLAUDE_CONFIG_DIR: '/account' } },
    ],
  ])
  expect(h.lookup).not.toHaveBeenCalled()
  expect(await h.env()).toEqual({ PATH: '/shell', CLAUDE_CONFIG_DIR: '/default' })
})

it('extracts prerelease versions and parses nonzero auth JSON', async () => {
  h.exec
    .mockResolvedValueOnce({ stdout: 'Claude Code v2.3.4-beta.1 (native)' })
    .mockRejectedValueOnce({ stdout: 'banner\n{"loggedIn":false}', message: 'exit 1' })
  expect(await claudeStatus()).toEqual({
    binary: { found: true, path: '/claude', version: '2.3.4-beta.1' },
    auth: { ok: true, loggedIn: false },
  })
  expect(h.lookup).toHaveBeenCalledExactlyOnceWith('claude')
})

it('reports missing binaries without querying env or subprocesses', async () => {
  h.lookup.mockResolvedValue(null)
  expect(await claudeStatus()).toEqual({
    binary: { found: false },
    auth: { ok: false, error: 'claude not found' },
  })
  expect(h.env).not.toHaveBeenCalled()
  expect(h.exec).not.toHaveBeenCalled()
})

it('uses the command failure when no auth stdout exists', async () => {
  h.exec
    .mockResolvedValueOnce({ stdout: 'no version' })
    .mockRejectedValueOnce(new Error('cannot run auth'))
  expect((await claudeStatus()).auth).toEqual({ ok: false, error: 'cannot run auth' })
})

it('parses all supported fields and ignores invalid field types', () => {
  expect(
    parseClaudeAuthStatus(
      'noise\n{"loggedIn":true,"authMethod":"oauth","email":"a@b","subscriptionType":"max","orgName":"org","orgId":"id"}',
    ),
  ).toEqual({
    ok: true,
    loggedIn: true,
    method: 'oauth',
    email: 'a@b',
    plan: 'max',
    organization: 'org',
    orgId: 'id',
  })
  expect(parseClaudeAuthStatus('{"loggedIn":"true","authMethod":1,"email":false}')).toEqual({
    ok: true,
    loggedIn: false,
  })
  expect(parseClaudeAuthStatus('{broken')).toEqual({
    ok: false,
    error: 'unparseable auth status output',
  })
  expect(parseClaudeAuthStatus('')).toEqual({ ok: false, error: 'no output' })
  expect(parseClaudeAuthStatus('x'.repeat(300))).toEqual({ ok: false, error: 'x'.repeat(200) })
})
