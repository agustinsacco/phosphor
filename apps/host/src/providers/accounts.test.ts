import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostClaudeAccounts } from './accounts'
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
