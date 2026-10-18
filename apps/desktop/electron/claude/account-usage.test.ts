import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs, ClaudeUsageSnapshot } from '@shared/models'

const state = vi.hoisted(() => ({ root: '', prefs: {} as ClaudeAccountPrefs }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../store', () => ({
  getClaudeAccountPrefs: () => state.prefs,
  setClaudeAccountPrefs: vi.fn(),
}))
vi.mock('../pi/packages', () => ({ claudeStatus: vi.fn() }))
vi.mock('./usage', () => ({ cachedUsageSnapshot: vi.fn(), fetchUsageSnapshot: vi.fn() }))
import { claudeStatus } from '../pi/packages'
import { cachedUsageSnapshot, fetchUsageSnapshot } from './usage'
import { accountUsageEnv, createAccountUsage } from './account-usage'
import { usageConfigDir } from './account-storage'

const NOW = 1_700_000_000_000
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
function usageService() {
  const loadAccounts = vi.fn(async () => state.prefs)
  const save = vi.fn((prefs: ClaudeAccountPrefs) => prefs)
  return { ...createAccountUsage({ loadAccounts, save }), loadAccounts, save }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  state.root = mkdtempSync(join(tmpdir(), 'claude-account-usage-'))
  state.prefs = {
    accounts: [account('a'), account('b')],
    mode: 'specific',
    cursor: 0,
    cooldowns: {},
    bindings: {},
  }
  vi.mocked(cachedUsageSnapshot).mockReturnValue(null)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})

describe('account-usage', () => {
  it('creates isolated probe config directories without relocating account credentials', () => {
    expect(existsSync(usageConfigDir('a'))).toBe(false)
    expect(accountUsageEnv({ ...account('a'), orgId: 'org-a' })).toEqual({
      CLAUDE_CONFIG_DIR: usageConfigDir('a'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/a',
      CLAUDE_CODE_ORGANIZATION_UUID: 'org-a',
    })
    expect(accountUsageEnv({ ...account('b'), credentialDir: null })).toEqual({
      CLAUDE_CONFIG_DIR: usageConfigDir('b'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    })
    expect(usageConfigDir('a')).not.toBe(usageConfigDir('b'))
    expect(existsSync(usageConfigDir('a'))).toBe(true)
    expect(existsSync(usageConfigDir('b'))).toBe(true)
  })

  it('probes per-account cache keys and persists learned orgs while retaining failed cooldowns', async () => {
    const service = usageService()
    state.prefs.cooldowns = { b: NOW + 5000 }
    vi.mocked(fetchUsageSnapshot).mockImplementation(async ({ cacheKey } = {}) => {
      if (cacheKey === 'b') throw new Error('probe failed')
      writeFileSync(
        join(usageConfigDir('a'), '.claude.json'),
        JSON.stringify({
          oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'org-a' },
        }),
      )
      return { ok: true, snapshot }
    })
    await service.refreshCooldowns('/bin/claude')
    expect(service.loadAccounts).toHaveBeenCalledWith('/bin/claude')
    for (const id of ['a', 'b']) {
      expect(fetchUsageSnapshot).toHaveBeenCalledWith({
        cacheKey: id,
        claudeOverride: '/bin/claude',
        extraEnv: {
          CLAUDE_CONFIG_DIR: usageConfigDir(id),
          CLAUDE_SECURESTORAGE_CONFIG_DIR: `/creds/${id}`,
        },
      })
    }
    expect(service.save).toHaveBeenCalledExactlyOnceWith({
      ...state.prefs,
      accounts: [{ ...account('a'), orgId: 'org-a' }, account('b')],
      cooldowns: { a: NOW + 1000, b: NOW + 5000 },
    })
  })

  it('leaves a cooldown intact on a failed result and omits absent binary overrides', async () => {
    const service = usageService()
    state.prefs.cooldowns = { a: NOW + 5000 }
    vi.mocked(fetchUsageSnapshot).mockResolvedValue({ ok: false, error: 'no-usage' })
    await service.refreshCooldowns()
    expect(service.save).toHaveBeenCalledWith(state.prefs)
    expect(vi.mocked(fetchUsageSnapshot).mock.calls[0]?.[0]).not.toHaveProperty('claudeOverride')
  })

  it('projects auth, cached usage and active cooldowns in stored order without probing', async () => {
    const service = usageService()
    state.prefs.cooldowns = { a: NOW + 1000, b: NOW }
    vi.mocked(claudeStatus)
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
    vi.mocked(cachedUsageSnapshot).mockImplementation((id) => (id === 'a' ? snapshot : null))
    expect(await service.accountViews('/bin/claude')).toEqual({
      prefs: state.prefs,
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
    expect(claudeStatus).toHaveBeenNthCalledWith(1, '/bin/claude', {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/a',
    })
    expect(cachedUsageSnapshot).toHaveBeenCalledWith('a', NOW)
    expect(cachedUsageSnapshot).toHaveBeenCalledWith('b', NOW)
    expect(fetchUsageSnapshot).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
    expect(existsSync(usageConfigDir('a'))).toBe(false)
  })

  it('projects status failures without rejecting the accounts result', async () => {
    const service = usageService()
    vi.mocked(claudeStatus).mockRejectedValue(new Error('status unavailable'))
    const result = await service.accountViews()
    expect(result.views.map((view) => view.auth)).toEqual([
      { ok: false, error: 'status check failed' },
      { ok: false, error: 'status check failed' },
    ])
  })
})
