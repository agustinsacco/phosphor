import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import type { StoredLane } from '../lanes/store'
import { createHostClaudeAccounts } from '../providers/accounts'
import { createAccountMoves } from './account-moves'

vi.mock('../machine/executables', () => ({ which: async () => '/claude' }))
vi.mock('../machine/probe', () => ({
  probe: async () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
}))
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'move-reservation-'))
  roots.push(directory)
  const accounts = createHostClaudeAccounts({ directory, home: directory, env: {} })
  const file = join(directory, 'session.jsonl')
  writeFileSync(file, '{}')
  const target = 'b8cf52cc-7a7d-4fbb-9dcb-c41c19cb030a'
  writeFileSync(
    join(directory, 'claude-accounts', 'accounts.json'),
    JSON.stringify({
      ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
      pinnedId: 'default',
      bindings: { [file]: 'default' },
      accounts: [
        { id: 'default', label: 'Former', credentialDir: null, addedAt: 1 },
        {
          id: target,
          label: 'Target',
          credentialDir: join(directory, 'claude-accounts', target),
          addedAt: 1,
        },
      ],
    }),
    { mode: 0o600 },
  )
  return { accounts, target, file }
}

it('reserves the move target while stop is suspended, preventing former-account fallback', async () => {
  const { accounts, target, file } = fixture()
  const lane = {
    laneId: 'lane',
    sessionFile: file,
    removedAt: null,
    model: { provider: 'pi-claude-cli', id: 'claude' },
  } as StoredLane
  let release!: () => void
  let entered!: () => void
  const stopped = new Promise<void>((resolve) => (release = resolve))
  const stopping = new Promise<void>((resolve) => (entered = resolve))
  const resumed: (string | undefined)[] = []
  const move = createAccountMoves({
    accounts,
    runtime: { withAuthorization: async (_authorized, run) => run() },
    store: { getLane: () => lane },
    binding: {
      stopLane: async () => {
        entered()
        await stopped
      },
      resumeLane: async () => {
        resumed.push((await accounts.accountForSpawn({ sessionPath: file }))?.id)
      },
    },
  })('lane', target, () => true)
  await stopping
  try {
    await expect(accounts.removeAccount(target)).rejects.toThrow('in use')
  } finally {
    release()
    await move
  }
  expect(resumed).toEqual([target])
})

it('rejects unknown binding targets rather than preserving a previous billing account', async () => {
  const { accounts, file } = fixture()
  await expect(accounts.bindSession(file, 'missing')).rejects.toThrow('Unknown Claude account')
  expect((await accounts.loadAccounts()).bindings[file]).toBe('default')
})
