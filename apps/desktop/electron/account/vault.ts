import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { AccountUser } from './gotrue'
import { avatarUrl } from './avatar'

/**
 * Where a remembered sign-in lives: the refresh token encrypted by the OS
 * (macOS Keychain, Windows DPAPI, Linux Secret Service or KWallet), and a
 * user-only plain token on Linux without a keyring. A plain profile lets startup
 * say who is signed in without touching the keychain. Nothing here ever reaches
 * electron-store, a log or the renderer.
 */

export type Storage =
  { readonly ok: true; readonly kind: string } | { readonly ok: false; readonly reason: string }

export interface Cipher {
  storage(): Storage
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export class VaultUnreadable extends Error {
  override readonly name = 'VaultUnreadable'
}

export interface Vault {
  storage(): Storage
  /** Never touches the keychain. On Linux, plain storage wins when both files exist. */
  savedMode(): 'keyring' | 'file' | null
  readProfile(): AccountUser | null
  /** Throws VaultUnreadable when the token is missing, foreign or unreadable. */
  readToken(userId: string): string
  /** False when storage is disabled: nothing is written then. */
  save(user: AccountUser, refreshToken: string): boolean
  /** Throws, after trying every file, when any could not be deleted. */
  clear(): void
}

/** Electron's safeStorage, structurally, so this file never imports electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

/**
 * On Linux, safeStorage "encrypts" with a hard-coded key when no keyring is
 * running (backend basic_text), so availability alone is not enough there.
 */
export function safeStorageCipher(api: SafeStorageLike, platform: NodeJS.Platform): Cipher {
  return {
    storage() {
      if (platform !== 'linux') {
        if (!api.isEncryptionAvailable())
          return { ok: false, reason: 'no secure storage is available' }
        return { ok: true, kind: platform === 'darwin' ? 'keychain' : 'dpapi' }
      }
      const backend = api.getSelectedStorageBackend?.() ?? 'unknown'
      // Only Chromium's own "no keyring" answer allows the file. Anything unrecognised fails closed.
      if (backend === 'basic_text') return { ok: true, kind: 'file' }
      const keyring = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)
      if (!keyring) return { ok: false, reason: 'the system keyring could not be identified' }
      if (!api.isEncryptionAvailable())
        return { ok: false, reason: 'the system keyring is unavailable' }
      return { ok: true, kind: backend }
    },
    encrypt: (text) => api.encryptString(text),
    decrypt: (data) => api.decryptString(data),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export function createVault(
  dir: string,
  cipher: Cipher,
  platform: NodeJS.Platform = process.platform,
  log: (message: string) => void = () => {},
  uid: () => number | undefined = () => process.getuid?.(),
): Vault {
  const profilePath = join(dir, 'profile.json')
  const tokenPath = join(dir, 'session.bin')
  const plainPath = join(dir, 'session.txt')

  function write(path: string, data: string | Buffer): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, data, { mode: 0o600, flag: 'wx' })
      renameSync(temp, path)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  /** Every file is attempted whatever the other did; any failure is thrown after. */
  function clear(): void {
    const failures: string[] = []
    // The credential first: if only one goes, it should be the secret.
    for (const path of [tokenPath, plainPath, profilePath, join(dir, 'avatar.json')]) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        failures.push(`${basename(path)} (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }
    if (failures.length > 0) throw new Error(`could not delete ${failures.join(' and ')}`)
  }

  function exists(path: string): boolean {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }

  function removeCopiedPlain(): void {
    if (platform !== 'linux' && exists(plainPath)) {
      rmSync(plainPath, { force: true })
      log('removed a plain sign-in file copied from Linux')
    }
  }

  function readProfile(): AccountUser | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(profilePath, 'utf8'))
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

  function encrypted(userId: string): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(cipher.decrypt(readFileSync(tokenPath)))
    } catch {
      throw new VaultUnreadable('the saved sign-in could not be decrypted')
    }
    if (!isRecord(parsed) || parsed.v !== 1 || parsed.userId !== userId)
      throw new VaultUnreadable('the saved sign-in belongs to someone else')
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken)
      throw new VaultUnreadable('the saved sign-in is damaged')
    return parsed.refreshToken
  }

  return {
    storage: () => cipher.storage(),
    savedMode: () => {
      removeCopiedPlain()
      return platform === 'linux' && exists(plainPath)
        ? 'file'
        : exists(tokenPath)
          ? 'keyring'
          : null
    },
    readProfile,
    readToken(userId) {
      removeCopiedPlain()
      if (!exists(tokenPath) && !exists(plainPath))
        throw new VaultUnreadable('the saved sign-in is missing')
      const storage = cipher.storage()
      if (!storage.ok) throw new VaultUnreadable(storage.reason)
      if (platform !== 'linux') {
        if (!exists(tokenPath)) throw new VaultUnreadable('the saved sign-in is missing')
        return encrypted(userId)
      }
      if (exists(tokenPath)) {
        let token: string | null = null
        try {
          token = encrypted(userId)
        } catch (error) {
          if (storage.kind !== 'file') throw error
          rmSync(tokenPath, { force: true })
          log('removed an unreadable encrypted sign-in; no keyring is running')
        }
        if (token !== null) {
          rmSync(plainPath, { force: true })
          return token
        }
      }
      if (!exists(plainPath)) throw new VaultUnreadable('the saved sign-in is missing')
      let fd: number | undefined
      try {
        fd = openSync(plainPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = fstatSync(fd)
        const owner = uid()
        if (
          !stat.isFile() ||
          owner === undefined ||
          stat.uid !== owner ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 4096
        )
          throw new VaultUnreadable('the saved sign-in file is unsafe')
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
        if (readProfile()?.id !== userId)
          throw new VaultUnreadable('the saved sign-in belongs to someone else')
        return token
      } catch {
        try {
          rmSync(plainPath, { force: true })
        } catch {
          try {
            rmdirSync(plainPath)
          } catch {
            log('could not remove an unsafe sign-in file')
            throw new VaultUnreadable('the unsafe sign-in file could not be removed')
          }
        }
        log('removed an unsafe or unreadable sign-in file')
        throw new VaultUnreadable('the saved sign-in file could not be read')
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
    save(user, refreshToken) {
      removeCopiedPlain()
      const storage = cipher.storage()
      if (!storage.ok || (storage.kind === 'file' && platform !== 'linux')) {
        clear()
        return false
      }
      if (storage.kind === 'file') {
        if (!refreshToken || Buffer.byteLength(refreshToken) > 4096)
          throw new VaultUnreadable('the sign-in token is too large or empty')
        if (exists(tokenPath)) {
          // Never silently downgrade a token that still decrypts.
          let readable = false
          try {
            encrypted(user.id)
            readable = true
          } catch {
            /* The old keyring is gone. */
          }
          if (readable)
            throw new VaultUnreadable('refused to replace a readable encrypted sign-in with a file')
          rmSync(tokenPath, { force: true })
          log('removed an unreadable encrypted sign-in; no keyring is running')
        }
        write(plainPath, refreshToken)
      } else {
        write(tokenPath, cipher.encrypt(JSON.stringify({ v: 1, userId: user.id, refreshToken })))
        rmSync(plainPath, { force: true })
      }
      write(profilePath, JSON.stringify({ v: 1, user }))
      return true
    },
    clear,
  }
}
