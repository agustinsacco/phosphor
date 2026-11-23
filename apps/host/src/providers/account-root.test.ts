import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claudeAccountRoot, writeClaudeAccountRoot } from './account-root'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import { createAccountMetadata } from './account-metadata'
import { createHostClaudeAccounts } from './accounts'

const uid = process.getuid?.()
let root: string
let state: string
let desktop: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'p4b-account-root-')))
  state = join(root, 'state')
  desktop = join(root, 'userData', 'claude-accounts')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(desktop, { recursive: true, mode: 0o700 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('keeps <state>/claude-accounts until a root is recorded', () => {
  expect(claudeAccountRoot(state, uid)).toBe(join(state, 'claude-accounts'))
  writeClaudeAccountRoot(state, uid, desktop)
  expect(claudeAccountRoot(state, uid)).toBe(desktop)
})

it('checks a recorded root on every read: an owner-private folder, never a link', () => {
  writeClaudeAccountRoot(state, uid, desktop)
  chmodSync(desktop, 0o755)
  expect(() => claudeAccountRoot(state, uid)).toThrow('Claude account directory must be private')
  chmodSync(desktop, 0o700)
  rmSync(desktop, { recursive: true })
  symlinkSync(state, desktop)
  expect(() => claudeAccountRoot(state, uid)).toThrow('Claude account directory must be private')
})

it('refuses to record a relative, root or non-private folder', () => {
  expect(() => writeClaudeAccountRoot(state, uid, 'claude-accounts')).toThrow('Invalid')
  expect(() => writeClaudeAccountRoot(state, uid, '/')).toThrow('Invalid')
  chmodSync(desktop, 0o750)
  expect(() => writeClaudeAccountRoot(state, uid, desktop)).toThrow('must be private')
})

it('the Host accounts use the recorded root, so its credential folders validate in place', async () => {
  writeClaudeAccountRoot(state, uid, desktop)
  const id = '6f1f7c1e-2a7b-4c1d-8e7f-0a1b2c3d4e5f'
  const account = { id, label: 'Work', credentialDir: join(desktop, id), addedAt: 1 }
  createAccountMetadata({ root: desktop, allowed: () => true }).write({
    ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
    accounts: [account],
  })
  const accounts = createHostClaudeAccounts({ directory: state, home: root, env: {} })
  expect((await accounts.loadAccounts()).accounts).toEqual([account])
})
