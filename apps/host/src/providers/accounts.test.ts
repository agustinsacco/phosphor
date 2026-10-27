import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostClaudeAccounts, readHostClaudeEnvironment } from './accounts'
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('../machine/executables', () => ({ which: async () => '/trusted/claude' }))
vi.mock('../machine/probe', () => ({ probe: auth }))
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }))
  vi.clearAllMocks()
})
function service() {
  const directory = mkdtempSync(join(tmpdir(), 'phosphor-host-accounts-'))
  roots.push(directory)
  return {
    directory,
    accounts: createHostClaudeAccounts({ directory, home: directory, env: { PATH: '/trusted' } }),
  }
}
function signedIn(email: string) {
  auth.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ loggedIn: true, email, accessToken: 'NEVER_STORE_THIS_TOKEN' }),
    stderr: '',
  })
}
it('keeps machine-owned metadata private, stores no auth output and isolates two Hosts', async () => {
  const a = service(),
    b = service()
  signedIn('first@example.test')
  const prefs = await a.accounts.loadAccounts()
  expect(prefs.accounts[0]?.id).toBe('default')
  const path = join(a.directory, 'claude-accounts', 'accounts.json')
  const json = readFileSync(path, 'utf8')
  expect(json).toContain('first@example.test')
  expect(json).not.toContain('NEVER_STORE_THIS_TOKEN')
  auth.mockResolvedValue({ code: 1, stdout: '{"loggedIn":false}', stderr: '' })
  expect((await b.accounts.loadAccounts()).accounts).toHaveLength(0)
})
it('preserves a duplicate account identity even when reauthentication uses a new private directory', async () => {
  const a = service()
  signedIn('first@example.test')
  await a.accounts.loadAccounts()
  const target = await a.accounts.beginAddAccount()
  await a.accounts.finishAddAccount(target.id)
  expect((await a.accounts.loadAccounts()).accounts).toHaveLength(1)
  // Read the persisted state again through a new service, not a cached preferences object.
  const reloaded = createHostClaudeAccounts({
    directory: a.directory,
    home: a.directory,
    env: { PATH: '/trusted' },
  })
  expect((await reloaded.loadAccounts()).accounts[0]?.credentialDir).toBe(
    join(a.directory, 'claude-accounts', target.id),
  )
})
it('lets doctor inspect the selected private account without writes, auth probes or cursor changes', async () => {
  const a = service()
  signedIn('first@example.test')
  await a.accounts.loadAccounts()
  const target = await a.accounts.beginAddAccount()
  signedIn('second@example.test')
  await a.accounts.finishAddAccount(target.id)
  await a.accounts.setRouting('specific', target.id)
  const file = join(a.directory, 'claude-accounts', 'accounts.json')
  const before = readFileSync(file, 'utf8')
  auth.mockClear()
  expect(
    readHostClaudeEnvironment({
      directory: a.directory,
      home: a.directory,
      env: { PATH: '/trusted' },
    }),
  ).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: join(a.directory, 'claude-accounts', target.id) })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(auth).not.toHaveBeenCalled()
  const empty = mkdtempSync(join(tmpdir(), 'readonly-accounts-'))
  roots.push(empty)
  expect(readHostClaudeEnvironment({ directory: empty, home: empty, env: {} })).toEqual({})
  expect(existsSync(join(empty, 'claude-accounts'))).toBe(false)
})
it('preserves multiple identities and selected credentials across a Host reload and an unreadable auth probe', async () => {
  const a = service()
  signedIn('personal@example.test')
  await a.accounts.loadAccounts()
  const work = await a.accounts.beginAddAccount()
  signedIn('work@example.test')
  await a.accounts.finishAddAccount(work.id)
  await a.accounts.setRouting('specific', work.id)
  const file = join(a.directory, 'claude-accounts', 'accounts.json')
  const before = readFileSync(file, 'utf8')
  const reloaded = createHostClaudeAccounts({
    directory: a.directory,
    home: a.directory,
    env: { PATH: '/trusted' },
  })
  auth.mockResolvedValue({ code: 1, stdout: '{"error":"temporarily unavailable"}', stderr: '' })
  expect(await reloaded.authenticationReady()).toBeNull()
  expect((await reloaded.loadAccounts()).accounts.map((account) => account.email)).toEqual([
    'personal@example.test',
    'work@example.test',
  ])
  expect(reloaded.credentialEnvironment()).toEqual({
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(a.directory, 'claude-accounts', work.id),
  })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(auth.mock.calls.every(([, args]) => !args.includes('logout'))).toBe(true)
})
it('refuses metadata commits after scoped authority is lost', async () => {
  const a = service()
  signedIn('first@example.test')
  await a.accounts.loadAccounts()
  const file = join(a.directory, 'claude-accounts', 'accounts.json')
  const before = readFileSync(file, 'utf8')
  let allowed = true
  await expect(
    a.accounts.withAuthorization(
      () => allowed,
      async () => {
        allowed = false
        await a.accounts.setRouting('round-robin', undefined)
      },
    ),
  ).rejects.toThrow('revoked')
  expect(readFileSync(file, 'utf8')).toBe(before)
})
it('refuses a seventeenth identity without corrupting the existing account registry', async () => {
  const a = service()
  signedIn('first@example.test')
  const prefs = await a.accounts.loadAccounts()
  for (let index = 1; index < 16; index++) {
    const id = randomUUID()
    prefs.accounts.push({
      id,
      label: `account ${index}`,
      email: `user${index}@example.test`,
      credentialDir: join(a.directory, 'claude-accounts', id),
      addedAt: 1,
    })
  }
  const file = join(a.directory, 'claude-accounts', 'accounts.json')
  writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 })
  const before = readFileSync(file, 'utf8')
  const target = await a.accounts.beginAddAccount()
  signedIn('new-identity@example.test')
  await expect(a.accounts.finishAddAccount(target.id)).rejects.toThrow('limit')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect((await a.accounts.loadAccounts()).accounts).toHaveLength(16)
})
it('refuses symlinked or malformed metadata without replacing it with a different billing account', async () => {
  const a = service(),
    b = service()
  const file = join(a.directory, 'claude-accounts', 'accounts.json')
  const foreign = join(b.directory, 'foreign')
  writeFileSync(foreign, '{}', { mode: 0o600 })
  symlinkSync(foreign, file)
  await expect(a.accounts.loadAccounts()).rejects.toThrow('private')
  rmSync(file)
  writeFileSync(file, '{bad json', { mode: 0o600 })
  await expect(a.accounts.accountForSpawn({})).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe('{bad json')
})
