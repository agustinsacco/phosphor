import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS, type ClaudeAccountPrefs } from '@phosphor/shared/models'
import { isUuid } from '@phosphor/shared/control-api'

interface MetadataContext {
  root: string
  path: string
  readOnly?: boolean
  allowed(): boolean
}

const validId = (id: unknown): id is string =>
  id === 'default' || (typeof id === 'string' && isUuid(id))

function validate(prefs: ClaudeAccountPrefs, root: string): void {
  if (
    !prefs ||
    !Array.isArray(prefs.accounts) ||
    prefs.accounts.length > 16 ||
    !['specific', 'ordered', 'round-robin'].includes(prefs.mode) ||
    !Number.isSafeInteger(prefs.cursor) ||
    prefs.cursor < 0 ||
    !prefs.bindings ||
    typeof prefs.bindings !== 'object' ||
    Array.isArray(prefs.bindings) ||
    !prefs.cooldowns ||
    typeof prefs.cooldowns !== 'object' ||
    Array.isArray(prefs.cooldowns)
  )
    throw new Error('Invalid Claude account metadata')
  for (const account of prefs.accounts)
    if (
      !validId(account.id) ||
      typeof account.label !== 'string' ||
      account.label.length > 300 ||
      account.label.includes('\0') ||
      (account.id !== 'default' && account.credentialDir === null) ||
      (account.credentialDir !== null &&
        (typeof account.credentialDir !== 'string' ||
          dirname(account.credentialDir) !== root ||
          !isUuid(basename(account.credentialDir))))
    )
      throw new Error('Invalid Claude account metadata')
  const ids = new Set(prefs.accounts.map((account) => account.id))
  if (
    ids.size !== prefs.accounts.length ||
    (prefs.pinnedId !== undefined && !ids.has(prefs.pinnedId)) ||
    Object.keys(prefs.bindings).length > 10_000 ||
    Object.entries(prefs.bindings).some(
      ([path, id]) =>
        !isAbsolute(path) || path.length > 4096 || path.includes('\0') || !ids.has(id),
    ) ||
    Object.entries(prefs.cooldowns).some(
      ([id, until]) => !validId(id) || !Number.isSafeInteger(until) || until < 0,
    )
  )
    throw new Error('Invalid Claude account metadata')
}

function read(context: MetadataContext): ClaudeAccountPrefs {
  let stat
  try {
    stat = lstatSync(context.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS)
    throw error
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 512 * 1024 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Claude account metadata must be private')
  const prefs = JSON.parse(readFileSync(context.path, 'utf8')) as ClaudeAccountPrefs
  validate(prefs, context.root)
  return prefs
}

function write(context: MetadataContext, prefs: ClaudeAccountPrefs): void {
  if (context.readOnly) throw new Error('Claude account metadata is read-only')
  if (!context.allowed()) throw new Error('Configuration access was revoked')
  if (prefs.accounts.length > 16) throw new Error('Claude account limit reached')
  const serialized = JSON.stringify(prefs)
  if (Buffer.byteLength(serialized) > 512 * 1024)
    throw new Error('Claude account metadata limit reached')
  const temporary = `${context.path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
    if (!context.allowed()) throw new Error('Configuration access was revoked')
    renameSync(temporary, context.path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* renamed or not created */
    }
  }
}

/** Metadata only. Claude owns credentials in its keychain or private credential file. */
export function createAccountMetadata(options: {
  root: string
  readOnly?: boolean
  allowed(): boolean
}) {
  if (!options.readOnly) mkdirSync(options.root, { recursive: true, mode: 0o700 })
  const dir = lstatSync(options.root)
  if (
    dir.isSymbolicLink() ||
    !dir.isDirectory() ||
    (dir.mode & 0o077) !== 0 ||
    (process.getuid && dir.uid !== process.getuid())
  )
    throw new Error('Claude account directory must be private')
  const context = { ...options, path: join(options.root, 'accounts.json') }
  return { read: () => read(context), write: (prefs: ClaudeAccountPrefs) => write(context, prefs) }
}
