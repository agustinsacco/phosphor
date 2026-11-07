import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs, ClaudeUsageSnapshot } from '@shared/models'
import type { ClaudeAccountPorts } from './account-ports'
import { createAccountState } from './account-state'
import { createAccountUsage } from './account-usage'

const NOW = 1_700_000_000_000
let root = ''
function account(id: string): ClaudeAccount {
  return { id, label: id, email: `${id}@example.com`, credentialDir: `/creds/${id}`, addedAt: 0 }
}
const snapshot: ClaudeUsageSnapshot = {
  fetchedAt: NOW,
  stale: false,
  contributing: null,
  windows: [
    { label: 'Current session', kind: 'five_hour', percentUsed: 100, resetsAt: NOW + 1000 },
  ],
}
function usageService(stored: Partial<ClaudeAccountPrefs> = {}) {
  let prefs: ClaudeAccountPrefs = {
    accounts: [account('a'), account('b')],
    mode: 'specific',
    cursor: 0,
    cooldowns: {},
    bindings: {},
    ...stored,
  }
  const ports = {
    root,
    read: () => prefs,
    write: vi.fn((next: ClaudeAccountPrefs) => {
      prefs = next
    }),
    status: vi.fn<ClaudeAccountPorts['status']>(),
    logout: vi.fn(),
    cachedUsage: vi.fn<ClaudeAccountPorts['cachedUsage']>(() => null),
    clearUsage: vi.fn(),
    fetchUsage: vi.fn<ClaudeAccountPorts['fetchUsage']>(),
  } satisfies ClaudeAccountPorts
  const state = createAccountState(ports)
  return { ...createAccountUsage(state), ports, state, prefs: () => prefs }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  root = mkdtempSync(join(tmpdir(), 'claude-account-usage-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('creates isolated probe config directories without relocating account credentials', () => {
  const service = usageService()
  const dir = service.state.usageConfigDir
  expect(existsSync(dir('a'))).toBe(false)
  expect(service.accountUsageEnv({ ...account('a'), orgId: 'org-a' })).toEqual({
    CLAUDE_CONFIG_DIR: dir('a'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/a',
    CLAUDE_CODE_ORGANIZATION_UUID: 'org-a',
  })
  expect(service.accountUsageEnv({ ...account('b'), credentialDir: null })).toEqual({
    CLAUDE_CONFIG_DIR: dir('b'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
  })
  expect(dir('a')).not.toBe(dir('b'))
  expect(existsSync(dir('a'))).toBe(true)
  expect(existsSync(dir('b'))).toBe(true)
})

it('probes per-account cache keys and persists learned orgs while retaining failed cooldowns', async () => {
  const service = usageService({ cooldowns: { b: NOW + 5000 } })
  const dir = service.state.usageConfigDir
  service.ports.fetchUsage.mockImplementation(async ({ cacheKey }) => {
    if (cacheKey === 'b') throw new Error('probe failed')
    writeFileSync(
      join(dir('a'), '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'org-a' },
      }),
    )
    return { ok: true, snapshot }
  })
  await service.refreshCooldowns('/bin/claude')
  for (const id of ['a', 'b'])
    expect(service.ports.fetchUsage).toHaveBeenCalledWith({
      cacheKey: id,
      claudeOverride: '/bin/claude',
      extraEnv: { CLAUDE_CONFIG_DIR: dir(id), CLAUDE_SECURESTORAGE_CONFIG_DIR: `/creds/${id}` },
    })
  expect(service.ports.write).toHaveBeenCalledOnce()
  expect(service.prefs()).toMatchObject({
    accounts: [{ ...account('a'), orgId: 'org-a' }, account('b')],
    cooldowns: { a: NOW + 1000, b: NOW + 5000 },
  })
})

it('leaves a cooldown intact on a failed result and omits absent binary overrides', async () => {
  const service = usageService({ cooldowns: { a: NOW + 5000 } })
  service.ports.fetchUsage.mockResolvedValue({ ok: false, error: 'no-usage' })
  await service.refreshCooldowns()
  expect(service.prefs().cooldowns).toEqual({ a: NOW + 5000 })
  expect(service.ports.fetchUsage.mock.calls[0]?.[0]).not.toHaveProperty('claudeOverride')
})

it('projects auth, cached usage and active cooldowns in stored order without probing', async () => {
  const service = usageService({ cooldowns: { a: NOW + 1000, b: NOW } })
  service.ports.status
    .mockResolvedValueOnce({
      binary: { found: true },
      auth: {
        ok: true,
        loggedIn: true,
        email: 'someone-else@example.com',
        plan: 'max',
        organization: 'other-org',
        orgId: 'other',
      },
    })
    .mockResolvedValueOnce({
      binary: { found: true },
      auth: { ok: true, loggedIn: false, email: 'b@example.com' },
    })
  service.ports.cachedUsage.mockImplementation((id) => (id === 'a' ? snapshot : null))
  expect(await service.accountViews('/bin/claude')).toEqual({
    prefs: service.prefs(),
    views: [
      {
        account: account('a'),
        auth: { ok: true, loggedIn: true },
        usage: snapshot,
        cooldownUntil: NOW + 1000,
      },
      {
        account: account('b'),
        auth: { ok: true, loggedIn: false, email: 'b@example.com' },
        usage: null,
        cooldownUntil: null,
      },
    ],
  })
  expect(service.ports.status).toHaveBeenNthCalledWith(1, '/bin/claude', {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/a',
  })
  expect(service.ports.cachedUsage).toHaveBeenCalledWith('a', NOW)
  expect(service.ports.cachedUsage).toHaveBeenCalledWith('b', NOW)
  expect(service.ports.fetchUsage).not.toHaveBeenCalled()
  expect(service.ports.write).not.toHaveBeenCalled()
  expect(existsSync(service.state.usageConfigDir('a'))).toBe(false)
})

it('projects status failures without rejecting the accounts result', async () => {
  const service = usageService()
  service.ports.status.mockRejectedValue(new Error('status unavailable'))
  const result = await service.accountViews()
  expect(result.views.map((view) => view.auth)).toEqual([
    { ok: false, error: 'status check failed' },
    { ok: false, error: 'status check failed' },
  ])
})
