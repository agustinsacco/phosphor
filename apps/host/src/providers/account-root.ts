import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { isPinnedPath } from '../config/schema'
import { readSidecar, writeSidecar } from '../config/sidecar'

const parseRoot = (raw: Record<string, unknown>) =>
  raw.version === 1 && isPinnedPath(raw.root) && dirname(raw.root) !== raw.root ? raw.root : null

function requirePrivateFolder(root: string, uid: number | undefined): string {
  const info = lstatSync(root)
  if (!info.isDirectory() || !isOwnerPrivate(info, uid))
    throw new Error('Claude account directory must be private')
  return root
}

/**
 * Where this Host keeps Claude account metadata: `<state>/claude-accounts`, or
 * the root a migration recorded. A migrated This Mac keeps Desktop's
 * `<userData>/claude-accounts`, because its credential folders never move
 * (reconcile-v2 #3). A recorded root is checked on every read: absolute and
 * an owner-private folder, never a link.
 */
export function claudeAccountRoot(stateDirectory: string, uid: number | undefined): string {
  const read = readSidecar(stateDirectory, HOST_SIDECARS.claudeAccounts, parseRoot, { uid })
  if (read.state === 'missing') return join(stateDirectory, 'claude-accounts')
  if (read.state === 'invalid') throw new Error('The Claude account root record is not usable.')
  return requirePrivateFolder(read.value, uid)
}

/** Records `root` as this Host's Claude account root; it must already be an owner-private folder. */
export function writeClaudeAccountRoot(
  stateDirectory: string,
  uid: number | undefined,
  root: string,
): void {
  if (!parseRoot({ version: 1, root })) throw new Error('Invalid Claude account root.')
  requirePrivateFolder(root, uid)
  writeSidecar(
    stateDirectory,
    HOST_SIDECARS.claudeAccounts,
    { version: 1, root },
    { uid, known: ['version', 'root'] },
  )
}
