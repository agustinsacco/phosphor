import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import type { AccountUser } from './gotrue'
import { avatarUrl } from './avatar'
import {
  clearVaultFiles,
  removeCopiedPlain,
  removeUnsafePlain,
  vaultFileExists,
  writeVaultFile,
  type VaultFileContext,
} from './vault-files'

/**
 * Credential decisions for the account vault: which saved token is read, when
 * a plain file is trusted, and when a save may replace what is there. Never
 * logs a token, and never silently downgrades one that still decrypts.
 *
 * Every keychain operation is a promise. On macOS the first one after an
 * update can sit behind a Keychain prompt for as long as the person leaves it
 * open; a synchronous call there froze the whole main process, so Phosphor
 * could neither show its window nor quit. File reads and writes stay
 * synchronous and happen on one side of the await only, so a sign-out that
 * runs during a keychain wait cannot interleave with them.
 */

export type Storage =
  { readonly ok: true; readonly kind: string } | { readonly ok: false; readonly reason: string }

export interface Cipher {
  storage(): Promise<Storage>
  encrypt(text: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<string>
}

export class VaultUnreadable extends Error {
  override readonly name = 'VaultUnreadable'
}

export interface VaultContext extends VaultFileContext {
  readonly cipher: Cipher
  /** The process user, who must own a plain token; undefined refuses it. */
  readonly uid: () => number | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export function readVaultProfile(context: VaultContext): AccountUser | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(context.paths.profile, 'utf8'))
  } catch {
    return null
  }
  const user = isRecord(parsed) && parsed.v === 1 ? parsed.user : null
  if (!isRecord(user) || typeof user.id !== 'string' || !user.id) return null
  const { login = null, name = null, email = null } = user
  if (!nullableText(login) || !nullableText(name) || !nullableText(email)) return null
  return {
    id: user.id,
    login,
    name,
    email,
    ...(avatarUrl(user.avatarUrl) ? { avatarUrl: avatarUrl(user.avatarUrl) ?? undefined } : {}),
  }
}

/** Never touches the keychain. On Linux, plain storage wins when both files exist. */
export function savedTokenMode(context: VaultContext): 'keyring' | 'file' | null {
  const { paths, platform } = context
  removeCopiedPlain(context)
  return platform === 'linux' && vaultFileExists(paths.plain)
    ? 'file'
    : vaultFileExists(paths.token)
      ? 'keyring'
      : null
}

/** The encrypted file's bytes, or null when it cannot be read (reported as undecryptable). */
function readSealed(context: VaultContext): Buffer | null {
  try {
    return readFileSync(context.paths.token)
  } catch {
    return null
  }
}

async function decryptToken(
  context: VaultContext,
  userId: string,
  sealed: Buffer | null,
): Promise<string> {
  let parsed: unknown
  try {
    if (sealed === null) throw new Error('unreadable')
    parsed = JSON.parse(await context.cipher.decrypt(sealed))
  } catch {
    throw new VaultUnreadable('the saved sign-in could not be decrypted')
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.userId !== userId)
    throw new VaultUnreadable('the saved sign-in belongs to someone else')
  if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken)
    throw new VaultUnreadable('the saved sign-in is damaged')
  return parsed.refreshToken
}

/** Checks and reads the open plain token; the path is never reopened after these checks. */
function readOwnedDescriptor(context: VaultContext, fd: number): string {
  const stat = fstatSync(fd)
  const owner = context.uid()
  if (
    !stat.isFile() ||
    owner === undefined ||
    stat.uid !== owner ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 4096
  )
    throw new VaultUnreadable('the saved sign-in file is unsafe')
  // One byte past the limit, so a file that grew after fstat is still caught.
  const buffer = Buffer.alloc(4097)
  let length = 0
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null)
    if (count === 0) break
    length += count
  }
  const token = buffer.subarray(0, length).toString('utf8')
  if (!token || Buffer.byteLength(token) > 4096)
    throw new VaultUnreadable('the saved sign-in is damaged')
  return token
}

/** Any refusal removes the file, so a bad plain token is never offered twice. */
function readPlainToken(context: VaultContext, userId: string): string {
  let fd: number | undefined
  try {
    fd = openSync(
      context.paths.plain,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const token = readOwnedDescriptor(context, fd)
    if (readVaultProfile(context)?.id !== userId)
      throw new VaultUnreadable('the saved sign-in belongs to someone else')
    return token
  } catch {
    if (!removeUnsafePlain(context)) {
      context.log('could not remove an unsafe sign-in file')
      throw new VaultUnreadable('the unsafe sign-in file could not be removed')
    }
    context.log('removed an unsafe or unreadable sign-in file')
    throw new VaultUnreadable('the saved sign-in file could not be read')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

type Settled = { readonly token: string } | { readonly error: unknown }

function settle(read: () => string): Settled {
  try {
    return { token: read() }
  } catch (error) {
    return { error }
  }
}

/**
 * Rejects with VaultUnreadable when the token is missing, foreign or unreadable.
 *
 * The token is read from disk before the first await, so a caller may delete
 * the vault right after calling: sign-out does exactly that, then revokes with
 * what this resolves to. Up front means the encrypted file's bytes (not yet
 * decrypted), and a Linux plain token only when it is the sole copy. With both
 * files on Linux, the plain one is opened only if the encrypted one fails, as
 * before; that leftover pair is the one case a sign-out may not revoke.
 */
export function readVaultToken(context: VaultContext, userId: string): Promise<string> {
  const { paths, platform } = context
  let sealed: Buffer | null | undefined
  let sole: Settled | undefined
  try {
    removeCopiedPlain(context)
    if (!vaultFileExists(paths.token) && !vaultFileExists(paths.plain))
      throw new VaultUnreadable('the saved sign-in is missing')
    if (vaultFileExists(paths.token)) sealed = readSealed(context)
    else if (platform === 'linux') sole = settle(() => readPlainToken(context, userId))
  } catch (error) {
    return Promise.reject(error)
  }
  return finishRead(context, userId, sealed, sole)
}

async function finishRead(
  context: VaultContext,
  userId: string,
  sealed: Buffer | null | undefined,
  sole: Settled | undefined,
): Promise<string> {
  const { cipher, paths, platform, log } = context
  const storage = await cipher.storage()
  if (!storage.ok) throw new VaultUnreadable(storage.reason)
  if (platform !== 'linux') {
    if (sealed === undefined) throw new VaultUnreadable('the saved sign-in is missing')
    return decryptToken(context, userId, sealed)
  }
  if (sole) {
    if ('error' in sole) throw sole.error
    return sole.token
  }
  if (sealed !== undefined) {
    let token: string | null = null
    try {
      token = await decryptToken(context, userId, sealed)
    } catch (error) {
      if (storage.kind !== 'file') throw error
      rmSync(paths.token, { force: true })
      log('removed an unreadable encrypted sign-in; no keyring is running')
    }
    if (token !== null) {
      rmSync(paths.plain, { force: true })
      return token
    }
  }
  if (!vaultFileExists(paths.plain)) throw new VaultUnreadable('the saved sign-in is missing')
  return readPlainToken(context, userId)
}

/** Whether the encrypted file still decrypts for this user. */
async function stillDecrypts(context: VaultContext, userId: string): Promise<boolean> {
  try {
    await decryptToken(context, userId, readSealed(context))
    return true
  } catch {
    return false /* The old keyring is gone. */
  }
}

/**
 * False when storage is disabled or `current()` turned false while the keychain
 * was busy: nothing is written then. Every write happens after the last await,
 * and only while `current()` holds, so a sign-out during a Keychain prompt is
 * never undone by a save that lands after it.
 */
export async function saveVaultToken(
  context: VaultContext,
  user: AccountUser,
  refreshToken: string,
  current: () => boolean = () => true,
): Promise<boolean> {
  const { cipher, paths, platform } = context
  removeCopiedPlain(context)
  const storage = await cipher.storage()
  if (!storage.ok || (storage.kind === 'file' && platform !== 'linux')) {
    if (current()) clearVaultFiles(context)
    return false
  }
  if (storage.kind === 'file') {
    if (!refreshToken || Buffer.byteLength(refreshToken) > 4096)
      throw new VaultUnreadable('the sign-in token is too large or empty')
    // Never silently downgrade a token that still decrypts; one that does not is removed.
    const encrypted = vaultFileExists(paths.token)
    const readable = encrypted && (await stillDecrypts(context, user.id))
    if (!current()) return false
    if (readable)
      throw new VaultUnreadable('refused to replace a readable encrypted sign-in with a file')
    if (encrypted) {
      rmSync(paths.token, { force: true })
      context.log('removed an unreadable encrypted sign-in; no keyring is running')
    }
    writeVaultFile(context, paths.plain, refreshToken)
  } else {
    const sealed = await cipher.encrypt(JSON.stringify({ v: 1, userId: user.id, refreshToken }))
    if (!current()) return false
    writeVaultFile(context, paths.token, sealed)
    rmSync(paths.plain, { force: true })
  }
  writeVaultFile(context, paths.profile, JSON.stringify({ v: 1, user }))
  return true
}
