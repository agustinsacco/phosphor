import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS, type ClaudeAccount } from '@phosphor/shared/models'
import { createAccountMetadata } from '../../providers/account-metadata'
import { claudeAccountRoot } from '../../providers/account-root'
import { createHostClaudeAccounts } from '../../providers/accounts'
import { OwnerCallRefused } from '../adapter'
import { ACCOUNT_REFUSALS, accountImporter } from './accounts'
import { scratchHost, snapshotFolder, uid, type ScratchHost } from './__fixtures__/scratch-host'

let host: ScratchHost
let desktop: string
beforeEach(async () => {
  host = await scratchHost()
  desktop = join(host.root, 'userData', 'claude-accounts')
  mkdirSync(desktop, { recursive: true, mode: 0o755 })
})
afterEach(() => host.close())

/** A Desktop account folder with a credential file the import must never touch. */
function account(label: string): ClaudeAccount {
  const id = randomUUID()
  const credentialDir = join(desktop, id)
  mkdirSync(credentialDir, { mode: 0o755 })
  writeFileSync(join(credentialDir, '.credentials.json'), `secret-${label}`, { mode: 0o644 })
  return { id, label, credentialDir, addedAt: 1 }
}

const section = (accounts: ClaudeAccount[]) => ({
  section: 'accounts' as const,
  accountRoot: desktop,
  accounts,
  mode: 'ordered' as const,
  cursor: 1,
  cooldowns: {},
  bindings: { [join(host.sessions, 'a', 'x.jsonl')]: accounts[0]!.id },
})

it('keeps credentials where Desktop put them: records its root and tightens only folder modes', async () => {
  const work = account('Work')
  const credential = join(work.credentialDir!, '.credentials.json')
  await accountImporter(host.ports).apply(section([work]), host.context())
  expect(claudeAccountRoot(host.state, uid)).toBe(desktop)
  expect(statSync(desktop).mode & 0o777).toBe(0o700)
  expect(statSync(work.credentialDir!).mode & 0o777).toBe(0o700)
  expect(statSync(credential).mode & 0o777).toBe(0o644)
  expect(readFileSync(credential, 'utf8')).toBe('secret-Work')
  const loaded = await createHostClaudeAccounts({
    directory: host.state,
    home: host.root,
    env: {},
  }).loadAccounts()
  expect(loaded).toMatchObject({ accounts: [work], mode: 'ordered', cursor: 1 })
  expect(Object.values(loaded.bindings)).toEqual([work.id])
})

it('refuses more accounts than the Host holds before writing anything', async () => {
  const many = Array.from({ length: 17 }, (_, i) => account(`A${i}`))
  await expect(accountImporter(host.ports).apply(section(many), host.context())).rejects.toEqual(
    new OwnerCallRefused('too-large', ACCOUNT_REFUSALS.tooMany),
  )
  expect(existsSync(join(host.state, 'claude-accounts.json'))).toBe(false)
  expect(statSync(desktop).mode & 0o777).toBe(0o755)
})

it('merge refuses when the daemon already has signed-in accounts in its own folder', async () => {
  const own = join(host.state, 'claude-accounts')
  const id = randomUUID()
  createAccountMetadata({ root: own, allowed: () => true }).write({
    ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
    accounts: [{ id, label: 'Daemon', credentialDir: join(own, id), addedAt: 1 }],
  })
  await expect(
    accountImporter(host.ports).apply(section([account('Work')]), host.context(true)),
  ).rejects.toEqual(new OwnerCallRefused('forbidden', ACCOUNT_REFUSALS.elsewhere))
  expect(claudeAccountRoot(host.state, uid)).toBe(own)
})

it('merge adds This Mac’s accounts beside the daemon’s default one', async () => {
  const own = join(host.state, 'claude-accounts')
  createAccountMetadata({ root: own, allowed: () => true }).write({
    ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
    accounts: [{ id: 'default', label: 'Default', credentialDir: null, addedAt: 0 }],
    mode: 'round-robin',
  })
  const work = account('Work')
  await accountImporter(host.ports).apply(section([work]), host.context(true))
  const prefs = createAccountMetadata({ root: desktop, allowed: () => true }).read()
  expect(prefs.accounts.map((a) => a.id)).toEqual(['default', work.id])
  expect(prefs.mode).toBe('round-robin')
})

it('abort forgets the recorded root and the records the import wrote, keeping older ones', async () => {
  const own = join(host.state, 'claude-accounts')
  const ownRecords = createAccountMetadata({ root: own, allowed: () => true })
  ownRecords.write({ ...DEFAULT_CLAUDE_ACCOUNT_PREFS, mode: 'specific' })
  const before = readFileSync(join(own, 'accounts.json'))
  const importer = accountImporter(host.ports)
  const folder = snapshotFolder(host, 'accounts')
  await importer.snapshot!(folder)
  await importer.apply(section([account('Work')]), host.context())
  await importer.restore!(folder)
  expect(existsSync(join(host.state, 'claude-accounts.json'))).toBe(false)
  expect(existsSync(join(desktop, 'accounts.json'))).toBe(false)
  expect(readFileSync(join(own, 'accounts.json'))).toEqual(before)
  expect(claudeAccountRoot(host.state, uid)).toBe(own)
})

it('refuses a folder that already holds account records the daemon did not write', async () => {
  writeFileSync(join(desktop, 'accounts.json'), '{}', { mode: 0o600 })
  await expect(
    accountImporter(host.ports).apply(section([account('Work')]), host.context()),
  ).rejects.toEqual(new OwnerCallRefused('forbidden', ACCOUNT_REFUSALS.stray))
})
