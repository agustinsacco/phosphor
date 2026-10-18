import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  type ClaudeAccount,
  type ClaudeAccountPrefs,
  type ClaudeStatus,
} from '@shared/models'
import { createClaudeAccounts, type ClaudeAccountPorts } from './accounts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const NOW = 1_700_000_000_000
function account(id: string): ClaudeAccount {
  return { id, label: id, email: `${id}@example.test`, credentialDir: null, addedAt: 1 }
}
function domain(overrides: Partial<ClaudeAccountPorts> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phosphor-account-runtime-'))
  roots.push(root)
  let prefs: ClaudeAccountPrefs = {
    ...structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS),
    accounts: [account('a'), account('b')],
  }
  const status = vi.fn(async (): Promise<ClaudeStatus> => ({
    binary: { found: true },
    auth: { ok: true, loggedIn: true, email: 'A@example.test' },
  }))
  const write = vi.fn((next: ClaudeAccountPrefs) => {
    prefs = next
  })
  const fetchUsage = vi.fn<ClaudeAccountPorts['fetchUsage']>(async () => ({
    ok: false,
    error: 'run-failed',
  }))
  const service = createClaudeAccounts({
    root,
    read: () => prefs,
    write,
    status,
    logout: async () => {},
    cachedUsage: () => null,
    clearUsage: () => {},
    fetchUsage,
    ...overrides,
  })
  return { root, prefs: () => prefs, service, status, write, fetchUsage }
}

it('does not probe or write stored accounts and prefers process affinity over saved bindings', async () => {
  const d = domain()
  expect((await d.service.loadAccounts()).accounts).toHaveLength(2)
  expect(d.status).not.toHaveBeenCalled()
  expect(d.write).not.toHaveBeenCalled()
  const path = join(d.root, 'session.jsonl')
  writeFileSync(path, '')
  await d.service.bindSession(path, 'a')
  expect(await d.service.sessionAccount({ accountId: 'b', sessionPath: path })).toMatchObject({
    id: 'b',
    alternative: { id: 'a', label: 'a@example.test' },
  })
  expect(await d.service.sessionAccount({ sessionPath: path })).toMatchObject({ id: 'a' })
  expect(await d.service.sessionAccount({ accountId: 'gone', sessionPath: path })).toBeNull()
  expect(d.fetchUsage).not.toHaveBeenCalled()
})

it('deduplicates case-insensitive email in the same org and retains the original id, label and age', async () => {
  const d = domain()
  const slot = await d.service.beginAddAccount('/trusted/claude')
  expect(existsSync(slot.env.CLAUDE_SECURESTORAGE_CONFIG_DIR!)).toBe(true)
  const result = await d.service.finishAddAccount(slot.id, '/trusted/claude')
  expect(result).toEqual({
    ...account('a'),
    email: 'A@example.test',
    credentialDir: join(d.root, slot.id),
  })
  expect(d.prefs().accounts.map((entry) => entry.id)).toEqual(['a', 'b'])
})

it('backfills only matching probe identities and prunes expired cooldowns and dead bindings on save', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const d = domain()
  const path = join(d.root, 'saved.jsonl')
  writeFileSync(path, '')
  await d.service.bindSession(path, 'a')
  rmSync(path)
  for (const entry of d.prefs().accounts) {
    const env = d.service.accountUsageEnv(entry)
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('')
    writeFileSync(
      join(env.CLAUDE_CONFIG_DIR!, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: entry.id === 'a' ? 'A@example.test' : 'someone-else@example.test',
          organizationUuid: `${entry.id}-org`,
        },
      }),
    )
  }
  d.prefs().cooldowns = { a: NOW - 1, b: NOW + 1000, removed: NOW + 2000 }
  await d.service.refreshCooldowns('/trusted/claude')
  expect(d.prefs().accounts.map((entry) => entry.orgId)).toEqual(['a-org', undefined])
  expect(d.prefs().cooldowns).toEqual({ b: NOW + 1000 })
  expect(d.prefs().bindings).toEqual({})
  expect(d.fetchUsage.mock.calls.map(([options]) => options)).toEqual(
    ['a', 'b'].map((id) => ({
      cacheKey: id,
      claudeOverride: '/trusted/claude',
      extraEnv: {
        CLAUDE_CONFIG_DIR: join(d.root, 'usage', id),
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      },
    })),
  )
})

it('propagates persistence failures and recovers the serialized mutation queue', async () => {
  let allowed = true
  const d = domain({
    write: () => {
      if (!allowed) throw new Error('Configuration access was revoked')
    },
  })
  d.status.mockImplementation(async () => {
    allowed = false
    return { binary: { found: true }, auth: { ok: true, loggedIn: true, email: 'new@test' } }
  })
  await expect(d.service.finishAddAccount('fresh-slot')).rejects.toThrow('revoked')
  expect(d.prefs().accounts.map((entry) => entry.id)).toEqual(['a', 'b'])
  allowed = true
  await expect(d.service.setRouting('ordered', undefined)).resolves.toBeUndefined()
  const broken = domain({
    read: () => {
      throw new Error('Invalid Claude account metadata')
    },
  })
  await expect(broken.service.accountForSpawn({})).rejects.toThrow(
    'Invalid Claude account metadata',
  )
  expect(broken.status).not.toHaveBeenCalled()
})
