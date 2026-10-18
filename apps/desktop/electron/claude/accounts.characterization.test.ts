import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs, ClaudeUsageSnapshotResult } from '@shared/models'

const state = vi.hoisted(() => ({ root: '', prefs: {} as ClaudeAccountPrefs }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../store', () => ({
  getClaudeAccountPrefs: () => state.prefs,
  setClaudeAccountPrefs: (prefs: ClaudeAccountPrefs) => {
    state.prefs = prefs
  },
}))
vi.mock('../pi/packages', () => ({ claudeStatus: vi.fn() }))
vi.mock('../pi/claude-login', () => ({ logoutClaude: vi.fn() }))
vi.mock('./usage', () => ({
  cachedUsageSnapshot: vi.fn(),
  clearUsageCache: vi.fn(),
  fetchUsageSnapshot: vi.fn(),
}))

import { claudeStatus } from '../pi/packages'
import { logoutClaude } from '../pi/claude-login'
import { clearUsageCache, fetchUsageSnapshot } from './usage'
import {
  accountForSpawn,
  beginAddAccount,
  bindSession,
  claudeAccountEnv,
  finishAddAccount,
  holdAccount,
  loadAccounts,
  primaryAccount,
  refreshCooldowns,
  removeAccount,
  sessionAccount,
} from './accounts'

const NOW = 1_700_000_000_000
function account(id: string): ClaudeAccount {
  return { id, label: id, email: `${id}@example.com`, credentialDir: `/creds/${id}`, addedAt: 1 }
}
function signedIn(email = 'a@example.com') {
  return { binary: { found: true }, auth: { ok: true, loggedIn: true, email, plan: 'max' } }
}
function usage(percentUsed: number): ClaudeUsageSnapshotResult {
  return {
    ok: true,
    snapshot: {
      fetchedAt: NOW,
      stale: false,
      contributing: null,
      windows: [{ label: 'Current session', kind: 'five_hour', percentUsed, resetsAt: NOW + 1000 }],
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  state.root = mkdtempSync(join(tmpdir(), 'claude-accounts-characterization-'))
  state.prefs = { accounts: [], mode: 'specific', cursor: 0, cooldowns: {}, bindings: {} }
  vi.mocked(claudeStatus).mockResolvedValue(signedIn())
  vi.mocked(fetchUsageSnapshot).mockResolvedValue({ ok: false, error: 'run-failed' })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})

describe('accounts public entry characterization', () => {
  it('seeds the terminal login without relocating its credential or creating directories', async () => {
    const prefs = await loadAccounts('/bin/claude')
    expect(prefs.accounts).toEqual([
      {
        id: 'default',
        label: 'a@example.com',
        email: 'a@example.com',
        plan: 'max',
        organization: undefined,
        credentialDir: null,
        addedAt: NOW,
      },
    ])
    expect(prefs.pinnedId).toBe('default')
    expect(existsSync(join(state.root, 'claude-accounts'))).toBe(false)
    expect(claudeAccountEnv(await primaryAccount())).toEqual({})
    expect(claudeStatus).toHaveBeenCalledExactlyOnceWith('/bin/claude')
  })

  it('does not seed a failed status and starts the first login on the default credential', async () => {
    vi.mocked(claudeStatus).mockRejectedValue(new Error('unavailable'))
    expect((await loadAccounts()).accounts).toEqual([])
    expect(await beginAddAccount()).toEqual({ id: 'default', env: {} })
  })

  it('persists the round-robin cursor while honoring an existing session binding', async () => {
    state.prefs = { ...state.prefs, accounts: [account('a'), account('b')], mode: 'round-robin' }
    const path = join(state.root, 'session.jsonl')
    writeFileSync(path, '')
    await bindSession(path, 'b')
    expect((await accountForSpawn({ sessionPath: path }, NOW))?.id).toBe('b')
    expect(state.prefs.cursor).toBe(0)
    expect((await accountForSpawn({}, NOW))?.id).toBe('a')
    expect(state.prefs.cursor).toBe(1)
    expect((await accountForSpawn({}, NOW))?.id).toBe('b')
    expect(state.prefs.cursor).toBe(0)
    expect(await sessionAccount({ sessionPath: path })).toMatchObject({ id: 'b', total: 2 })
    await refreshCooldowns()
  })

  it('reauthenticates a duplicate email in place with the new credential directory', async () => {
    state.prefs = { ...state.prefs, accounts: [account('a'), account('b')], pinnedId: 'b' }
    const result = await finishAddAccount('new-login', '/bin/claude')
    expect(result).toEqual({
      ...account('a'),
      plan: 'max',
      credentialDir: join(state.root, 'claude-accounts', 'new-login'),
    })
    expect(state.prefs.accounts.map((a) => a.id)).toEqual(['a', 'b'])
    expect(state.prefs.pinnedId).toBe('b')
    expect(clearUsageCache).toHaveBeenCalledWith('a')
    expect(claudeStatus).toHaveBeenCalledWith('/bin/claude', {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(state.root, 'claude-accounts', 'new-login'),
    })
  })

  it('merges parallel usage results into the latest prefs after awaiting all probes', async () => {
    state.prefs = {
      ...state.prefs,
      accounts: [account('a'), account('b')],
      cooldowns: { b: NOW + 5000 },
    }
    let completeA!: (result: ClaudeUsageSnapshotResult) => void
    let completeB!: (result: ClaudeUsageSnapshotResult) => void
    vi.mocked(fetchUsageSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeA = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeB = resolve
          }),
      )
    const pending = refreshCooldowns('/bin/claude')
    await vi.waitFor(() => expect(fetchUsageSnapshot).toHaveBeenCalledTimes(2))
    state.prefs = {
      ...state.prefs,
      accounts: [account('b'), account('a'), account('c')],
      mode: 'round-robin',
      pinnedId: 'c',
      cursor: 2,
      cooldowns: { b: NOW + 5000, c: NOW + 7000 },
    }
    completeA(usage(100))
    completeB(usage(20))
    await pending
    expect(state.prefs.accounts.map((a) => a.id)).toEqual(['b', 'a', 'c'])
    expect(state.prefs).toMatchObject({
      mode: 'round-robin',
      pinnedId: 'c',
      cursor: 2,
      cooldowns: { a: NOW + 1000, c: NOW + 7000 },
    })
    expect(state.prefs.cooldowns).not.toHaveProperty('b')
  })

  it('never shortens a provider hold and ignores unknown accounts', async () => {
    state.prefs.accounts = [account('a')]
    await holdAccount('a', NOW + 5000)
    await holdAccount('a', NOW + 1000)
    await holdAccount('missing', NOW + 9000)
    expect(state.prefs.cooldowns).toEqual({ a: NOW + 5000 })
    await holdAccount('a', NOW + 8000)
    expect(state.prefs.cooldowns).toEqual({ a: NOW + 8000 })
  })

  it('removes an account despite logout failure and prunes its bindings and cooldown', async () => {
    const path = join(state.root, 'session.jsonl')
    writeFileSync(path, '')
    state.prefs = {
      ...state.prefs,
      accounts: [account('a'), account('b')],
      pinnedId: 'a',
      bindings: { [path]: 'a' },
      cooldowns: { a: NOW + 1000 },
    }
    vi.mocked(logoutClaude).mockRejectedValue(new Error('logout failed'))
    await removeAccount('a', '/bin/claude')
    expect(state.prefs).toMatchObject({
      accounts: [account('b')],
      pinnedId: 'b',
      bindings: {},
      cooldowns: {},
    })
    expect(logoutClaude).toHaveBeenCalledWith('/bin/claude', {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/a',
    })
    expect(clearUsageCache).toHaveBeenCalledWith('a')
  })
})
