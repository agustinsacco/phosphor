/**
 * The `accounts` section: Claude account metadata and bindings. Credential
 * folders stay where Desktop made them: the daemon records Desktop's
 * `<userData>/claude-accounts` as its account root and only tightens the
 * modes of that root and its account folders to 0700 (reconcile-v2 #3). It
 * never reads, moves or rewrites a credential.
 */
import { chmod, lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS, type ClaudeAccountPrefs } from '@phosphor/shared/models'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { readSidecar } from '../../config/sidecar'
import { createAccountMetadata } from '../../providers/account-metadata'
import { claudeAccountRoot, writeClaudeAccountRoot } from '../../providers/account-root'
import type { MigrationImporter } from '../migrate'
import { refuseImport, type ImportPorts } from './ports'
import { keepFile, putBackFile } from './snapshot'

/** The Host's own account limit; the wire admits more. */
export const HOST_ACCOUNT_LIMIT = 16

export const ACCOUNT_REFUSALS = {
  tooMany: `This Mac has more Claude accounts than the Phosphor service can hold (${HOST_ACCOUNT_LIMIT}).`,
  folder: 'A Claude account folder on this Mac is not an owned folder.',
  stray: 'The Claude account folder already holds account records. Nothing was changed.',
  elsewhere: 'The Phosphor service already has Claude accounts in another folder.',
  collision: 'A Claude account on this Mac has the same id as a different one on the service.',
} as const

type AccountsSection = Parameters<MigrationImporter<'accounts'>['apply']>[0]

/** An owned folder, never a link: its path and mode, or null when missing and allowed. */
async function ownedFolder(path: string, uid: number | undefined, allowMissing: boolean) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (allowMissing && errnoIs(error, 'ENOENT')) return null
    throw refuseImport('bad-request', ACCOUNT_REFUSALS.folder)
  }
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
    throw refuseImport('bad-request', ACCOUNT_REFUSALS.folder)
  return { path, mode: info.mode }
}

/** The account root and every account folder, all checked before any mode changes to 0700. */
async function tightenFolders(section: AccountsSection, uid: number | undefined) {
  const folders = [await ownedFolder(section.accountRoot, uid, false)]
  for (const account of section.accounts)
    if (account.credentialDir) folders.push(await ownedFolder(account.credentialDir, uid, true))
  for (const folder of folders)
    if (folder && (folder.mode & 0o077) !== 0) await chmod(folder.path, folder.mode & 0o700)
}

async function hasFile(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

/** Merge keeps the daemon's routing and adds This Mac's accounts and bindings. */
export function importedAccounts(
  section: AccountsSection,
  existing: ClaudeAccountPrefs,
  merge: boolean,
): ClaudeAccountPrefs {
  const imported: ClaudeAccountPrefs = {
    accounts: [...section.accounts],
    mode: section.mode,
    ...(section.pinnedId ? { pinnedId: section.pinnedId } : {}),
    cursor: section.cursor,
    cooldowns: { ...section.cooldowns },
    bindings: { ...section.bindings },
  }
  if (!merge) return imported
  const accounts = [...existing.accounts]
  for (const account of imported.accounts) {
    const same = accounts.find((a) => a.id === account.id)
    if (!same) accounts.push(account)
    else if (!isDeepStrictEqual(same, account))
      throw refuseImport('forbidden', ACCOUNT_REFUSALS.collision)
  }
  return {
    ...existing,
    accounts,
    cooldowns: { ...imported.cooldowns, ...existing.cooldowns },
    bindings: { ...imported.bindings, ...existing.bindings },
  }
}

/** The root the accounts sidecar names now, or the default one. */
function recordedRoot(ports: ImportPorts): string {
  const read = readSidecar(
    ports.stateDirectory,
    HOST_SIDECARS.claudeAccounts,
    (raw) => (typeof raw.root === 'string' ? raw.root : null),
    { uid: ports.uid },
  )
  return read.state === 'ok' ? read.value : join(ports.stateDirectory, 'claude-accounts')
}

export function accountImporter(ports: ImportPorts): MigrationImporter<'accounts'> {
  const sidecar = join(ports.stateDirectory, HOST_SIDECARS.claudeAccounts)
  const metadata = (root: string) => createAccountMetadata({ root, allowed: () => true })
  return {
    async apply(section, { merge }) {
      if (section.accounts.length > HOST_ACCOUNT_LIMIT)
        throw refuseImport('too-large', ACCOUNT_REFUSALS.tooMany)
      const root = section.accountRoot
      const current = claudeAccountRoot(ports.stateDirectory, ports.uid)
      const moving = current !== root
      if (moving && (await hasFile(join(root, 'accounts.json'))))
        throw refuseImport('forbidden', ACCOUNT_REFUSALS.stray)
      const existing = (await hasFile(join(current, 'accounts.json')))
        ? metadata(current).read()
        : structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS)
      if (merge && moving && existing.accounts.some((a) => a.credentialDir !== null))
        throw refuseImport('forbidden', ACCOUNT_REFUSALS.elsewhere)
      const next = importedAccounts(section, existing, merge)
      if (next.accounts.length > HOST_ACCOUNT_LIMIT)
        throw refuseImport('too-large', ACCOUNT_REFUSALS.tooMany)
      // Only now does anything change: folder modes, then the record, then the metadata.
      await tightenFolders(section, ports.uid)
      // The record before the metadata: abort finds the root it must clear through it.
      writeClaudeAccountRoot(ports.stateDirectory, ports.uid, root)
      const accounts = metadata(root)
      accounts.write(next)
      accounts.read()
    },
    async snapshot(into) {
      await keepFile(sidecar, into, 'root')
      await keepFile(join(recordedRoot(ports), 'accounts.json'), into, 'accounts')
    },
    /** A root the import moved to held no records before it, so its records go. */
    async restore(from) {
      const now = recordedRoot(ports)
      await putBackFile(sidecar, from, 'root')
      const before = recordedRoot(ports)
      if (now !== before) await rm(join(now, 'accounts.json'), { force: true })
      await putBackFile(join(before, 'accounts.json'), from, 'accounts')
    },
  }
}
