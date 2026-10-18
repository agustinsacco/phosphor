import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  type ClaudeAccountPrefs,
  type ClaudeStatus,
} from '@shared/models'
import { createClaudeAccounts } from './accounts'
import { claudeAccountEnv } from './routing'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function domain() {
  const root = mkdtempSync(join(tmpdir(), 'phosphor-accounts-'))
  roots.push(root)
  let prefs: ClaudeAccountPrefs = structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS)
  const status = vi.fn(async (): Promise<ClaudeStatus> => ({
    binary: { found: true },
    auth: { ok: true, loggedIn: false },
  }))
  const service = createClaudeAccounts({
    root,
    read: () => prefs,
    write: (value) => {
      prefs = value
    },
    status,
    logout: vi.fn(async () => {}),
    cachedUsage: () => null,
    clearUsage: () => {},
    fetchUsage: async () => ({ ok: false, error: 'no-usage' }),
  })
  const signIn = (email: string) =>
    status.mockResolvedValue({
      binary: { found: true },
      auth: { ok: true, loggedIn: true, email, orgId: email + '-org' },
    })
  return { root, service, status, signIn, prefs: () => prefs }
}
it('seeds the existing credential, isolates additional credentials and deduplicates reauthentication', async () => {
  const d = domain()
  d.signIn('first@example.test')
  expect((await d.service.loadAccounts()).accounts[0]?.credentialDir).toBeNull()
  const target = await d.service.beginAddAccount()
  expect(target.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(d.root, target.id))
  d.signIn('second@example.test')
  await d.service.finishAddAccount(target.id)
  expect(d.prefs().accounts).toHaveLength(2)
  const retry = await d.service.beginAddAccount()
  await d.service.finishAddAccount(retry.id)
  expect(d.prefs().accounts).toHaveLength(2)
  expect(d.prefs().accounts[1]?.credentialDir).toBe(join(d.root, retry.id))
  expect(claudeAccountEnv(d.prefs().accounts[1]!)).toMatchObject({
    CLAUDE_CODE_ORGANIZATION_UUID: 'second@example.test-org',
  })
})
it('keeps the same email in different organizations as separate billing identities', async () => {
  const d = domain()
  d.signIn('person@example.test')
  await d.service.loadAccounts()
  expect(d.prefs().accounts[0]?.orgId).toBe('person@example.test-org')
  const path = join(d.root, 'saved.jsonl')
  writeFileSync(path, '')
  await d.service.bindSession(path, 'default')
  const second = await d.service.beginAddAccount()
  d.status.mockResolvedValue({
    binary: { found: true },
    auth: { ok: true, loggedIn: true, email: 'person@example.test', orgId: 'different-org' },
  })
  await d.service.finishAddAccount(second.id)
  expect(d.prefs().accounts).toHaveLength(2)
  expect(d.prefs().accounts[1]?.label).toContain(second.id.slice(0, 8))
  await d.service.setRouting('specific', second.id)
  expect(claudeAccountEnv(await d.service.accountForSpawn({ sessionPath: path }))).toMatchObject({
    CLAUDE_CODE_ORGANIZATION_UUID: 'person@example.test-org',
  })
  expect(claudeAccountEnv(await d.service.accountForSpawn({}))).toMatchObject({
    CLAUDE_CODE_ORGANIZATION_UUID: 'different-org',
  })
})

it('never records a failed login, and never shares account state between machines', async () => {
  const a = domain(),
    b = domain()
  const pending = await a.service.beginAddAccount()
  expect(await a.service.finishAddAccount(pending.id)).toBeNull()
  expect(a.prefs().accounts).toHaveLength(0)
  a.signIn('a@example.test')
  await a.service.loadAccounts()
  expect((await b.service.loadAccounts()).accounts).toHaveLength(0)
})
it('routes new sessions, skips held accounts and keeps a resumed file on its original account', async () => {
  const d = domain()
  d.signIn('a@example.test')
  await d.service.loadAccounts()
  const second = await d.service.beginAddAccount()
  d.signIn('b@example.test')
  await d.service.finishAddAccount(second.id)
  await d.service.setRouting('round-robin', undefined)
  const simultaneous = await Promise.all([
    d.service.accountForSpawn({}, 1000),
    d.service.accountForSpawn({}, 1000),
  ])
  expect(simultaneous.map((account) => account?.id)).toEqual(['default', second.id])
  const path = join(d.root, 'session.jsonl')
  writeFileSync(path, '')
  await d.service.bindSession(path, second.id)
  await d.service.holdAccount(second.id, 9000)
  await d.service.setRouting('ordered', undefined)
  expect((await d.service.accountForSpawn({}, 1000))?.id).toBe('default')
  expect((await d.service.accountForSpawn({ sessionPath: path }, 1000))?.id).toBe(second.id)
  await d.service.removeAccount(second.id)
  expect(d.prefs().bindings[path]).toBeUndefined()
})
