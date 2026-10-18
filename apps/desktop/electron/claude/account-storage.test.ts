import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs } from '@shared/models'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../store', () => ({ setClaudeAccountPrefs: vi.fn() }))
import { setClaudeAccountPrefs } from '../store'
import { accountsRoot, backfillOrgIds, save, tidy, usageConfigDir } from './account-storage'

const NOW = 1_700_000_000_000
function account(id: string): ClaudeAccount {
  return { id, label: id, email: `${id}@example.com`, credentialDir: null, addedAt: 0 }
}
function prefs(accounts: ClaudeAccount[] = [account('a')]): ClaudeAccountPrefs {
  return { accounts, mode: 'specific', cursor: 0, cooldowns: {}, bindings: {} }
}
function probe(id: string, text: string): void {
  mkdirSync(usageConfigDir(id), { recursive: true })
  writeFileSync(join(usageConfigDir(id), '.claude.json'), text)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.root = mkdtempSync(join(tmpdir(), 'claude-account-storage-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})

describe('account-storage', () => {
  it('resolves lazy account paths under the current userData without creating directories', () => {
    expect(accountsRoot()).toBe(join(state.root, 'claude-accounts'))
    expect(usageConfigDir('a')).toBe(join(state.root, 'claude-accounts', 'usage', 'a'))
    const stored = prefs()
    expect(backfillOrgIds(stored)).toBe(stored)
    expect(existsSync(accountsRoot())).toBe(false)
    const originalRoot = state.root
    state.root = join(originalRoot, 'other-user')
    expect(accountsRoot()).toBe(join(state.root, 'claude-accounts'))
    state.root = originalRoot
  })

  it('prunes dead bindings and expired or unknown cooldowns without mutating the input', () => {
    const live = join(state.root, 'live.jsonl')
    const unknown = join(state.root, 'unknown.jsonl')
    const gone = join(state.root, 'gone.jsonl')
    writeFileSync(live, '')
    writeFileSync(unknown, '')
    const stored = {
      ...prefs([account('a'), account('b')]),
      bindings: { [live]: 'a', [gone]: 'a', [unknown]: 'removed' },
      cooldowns: { a: NOW + 1, b: NOW, removed: NOW + 1 },
    }
    expect(tidy(stored, NOW)).toEqual({
      ...stored,
      bindings: { [live]: 'a' },
      cooldowns: { a: NOW + 1 },
    })
    expect(stored.bindings).toHaveProperty(gone)
    expect(stored.cooldowns).toEqual({ a: NOW + 1, b: NOW, removed: NOW + 1 })
  })

  it('saves and returns the tidied prefs at the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const stored = { ...prefs(), cooldowns: { a: NOW } }
    const saved = save(stored)
    expect(saved.cooldowns).toEqual({})
    expect(setClaudeAccountPrefs).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('backfills only a missing org from the account own matching probe identity', () => {
    const stored = prefs([account('a'), { ...account('b'), orgId: 'existing' }, account('c')])
    probe(
      'a',
      JSON.stringify({
        oauthAccount: { emailAddress: 'A@EXAMPLE.COM', organizationUuid: 'org-a' },
      }),
    )
    probe(
      'b',
      JSON.stringify({
        oauthAccount: { emailAddress: 'b@example.com', organizationUuid: 'new-org' },
      }),
    )
    probe(
      'c',
      JSON.stringify({
        oauthAccount: { emailAddress: 'other@example.com', organizationUuid: 'wrong-org' },
      }),
    )
    const result = backfillOrgIds(stored)
    expect(result.accounts).toEqual([
      { ...account('a'), orgId: 'org-a' },
      stored.accounts[1],
      stored.accounts[2],
    ])
    expect(stored.accounts[0]).not.toHaveProperty('orgId')
    expect(result.accounts[1]).toBe(stored.accounts[1])
  })

  it('leaves prefs unchanged for missing, malformed or incomplete probe identities', () => {
    const stored = prefs([account('a'), account('b'), account('c'), account('d')])
    probe('a', 'not json')
    probe(
      'b',
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com', organizationUuid: 3 } }),
    )
    probe('c', '{}')
    expect(backfillOrgIds(stored)).toBe(stored)
  })
})
