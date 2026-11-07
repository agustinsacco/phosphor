import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs } from '@shared/models'
import { createAccountState } from './account-state'

const NOW = 1_700_000_000_000
let root = ''
function account(id: string): ClaudeAccount {
  return { id, label: id, email: `${id}@example.com`, credentialDir: null, addedAt: 0 }
}
function prefs(accounts: ClaudeAccount[] = [account('a')]): ClaudeAccountPrefs {
  return { accounts, mode: 'specific', cursor: 0, cooldowns: {}, bindings: {} }
}
function accountState() {
  const write = vi.fn()
  const state = createAccountState({
    get root() {
      return root
    },
    read: () => prefs(),
    write,
    status: vi.fn(),
    logout: vi.fn(),
    cachedUsage: () => null,
    clearUsage: vi.fn(),
    fetchUsage: vi.fn(),
  })
  return { state, write }
}
function probe(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-account-state-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('resolves probe directories under the current root lazily without creating them', () => {
  const { state } = accountState()
  const original = root
  expect(state.usageConfigDir('a')).toBe(join(original, 'usage', 'a'))
  root = join(original, 'other-user')
  expect(state.usageConfigDir('a')).toBe(join(original, 'other-user', 'usage', 'a'))
  root = original
  expect(existsSync(join(root, 'usage'))).toBe(false)
})

it('saves live bindings only and drops expired or unknown cooldowns without mutating the input', () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const { state, write } = accountState()
  const live = join(root, 'live.jsonl')
  const unknown = join(root, 'unknown.jsonl')
  const gone = join(root, 'gone.jsonl')
  writeFileSync(live, '')
  writeFileSync(unknown, '')
  const stored = {
    ...prefs([account('a'), account('b')]),
    bindings: { [live]: 'a', [gone]: 'a', [unknown]: 'removed' },
    cooldowns: { a: NOW + 1, b: NOW, removed: NOW + 1 },
  }
  const saved = state.save(stored)
  expect(saved).toEqual({ ...stored, bindings: { [live]: 'a' }, cooldowns: { a: NOW + 1 } })
  expect(write).toHaveBeenCalledExactlyOnceWith(saved)
  expect(stored.bindings).toHaveProperty(gone)
  expect(stored.cooldowns).toEqual({ a: NOW + 1, b: NOW, removed: NOW + 1 })
})

it('backfills only a missing org and leaves prefs unchanged for unreadable probe identities', () => {
  const { state } = accountState()
  const dir = state.usageConfigDir
  const stored = prefs([account('a'), { ...account('b'), orgId: 'existing' }, account('c')])
  const identity = (email: string, org: unknown) =>
    JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org } })
  probe(dir('a'), identity('A@EXAMPLE.COM', 'org-a'))
  probe(dir('b'), identity('b@example.com', 'new-org'))
  probe(dir('c'), 'not json')
  const result = state.backfillOrgIds(stored)
  expect(result.accounts).toEqual([
    { ...account('a'), orgId: 'org-a' },
    stored.accounts[1],
    stored.accounts[2],
  ])
  expect(stored.accounts[0]).not.toHaveProperty('orgId')
  expect(result.accounts[1]).toBe(stored.accounts[1])
  const unreadable = prefs([account('c'), account('d')])
  expect(state.backfillOrgIds(unreadable)).toBe(unreadable)
})
