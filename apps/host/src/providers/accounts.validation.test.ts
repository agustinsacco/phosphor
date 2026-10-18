import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import { createHostClaudeAccounts, readHostClaudeEnvironment } from './accounts'

const probe = vi.hoisted(() => vi.fn())
vi.mock('../machine/executables', () => ({ which: async () => '/claude' }))
vi.mock('../machine/probe', () => ({ probe }))
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.clearAllMocks()
})

it('refuses a private account whose credential scope was corrupted to the default entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'invalid-account-scope-'))
  roots.push(directory)
  const options = { directory, home: directory, env: {} }
  const accounts = createHostClaudeAccounts(options)
  const id = 'b8cf52cc-7a7d-4fbb-9dcb-c41c19cb030a'
  const path = join(directory, 'claude-accounts', 'accounts.json')
  const metadata = JSON.stringify({
    ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
    pinnedId: id,
    accounts: [{ id, label: 'Private', credentialDir: null, addedAt: 1 }],
  })
  writeFileSync(path, metadata, { mode: 0o600 })

  await expect(accounts.accountForSpawn({})).rejects.toThrow('Invalid Claude account metadata')
  expect(() => readHostClaudeEnvironment(options)).toThrow('Invalid Claude account metadata')
  expect(readFileSync(path, 'utf8')).toBe(metadata)
  expect(probe).not.toHaveBeenCalled()
})
