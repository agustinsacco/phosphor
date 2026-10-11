import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountUser } from './gotrue'

/**
 * Where a remembered sign-in lives: the refresh token encrypted by the OS
 * (macOS Keychain, Windows DPAPI, Linux Secret Service or KWallet), and a
 * plain profile beside it so startup can say who is signed in without
 * touching the keychain. Nothing here ever reaches electron-store, a log or
 * the renderer.
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
  readProfile(): AccountUser | null
  /** Decrypts; throws VaultUnreadable when the token is missing, foreign or undecryptable. */
  readToken(userId: string): string
  /** False when the OS offers no secure storage: nothing is written then. */
  save(user: AccountUser, refreshToken: string): boolean
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
      if (!api.isEncryptionAvailable())
        return { ok: false, reason: 'no secure storage is available' }
      if (platform !== 'linux')
        return { ok: true, kind: platform === 'darwin' ? 'keychain' : 'dpapi' }
      const backend = api.getSelectedStorageBackend?.() ?? 'unknown'
      if (backend === 'basic_text' || backend === 'unknown') {
        return { ok: false, reason: 'no system keyring (Secret Service or KWallet) is running' }
      }
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

export function createVault(dir: string, cipher: Cipher): Vault {
  const profilePath = join(dir, 'profile.json')
  const tokenPath = join(dir, 'session.bin')

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

  function clear(): void {
    // Profile first: without it the token is never read.
    rmSync(profilePath, { force: true })
    rmSync(tokenPath, { force: true })
  }

  return {
    storage: () => cipher.storage(),
    readProfile() {
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
      return { id: user.id, login, name, email }
    },
    readToken(userId) {
      let data: Buffer
      try {
        data = readFileSync(tokenPath)
      } catch {
        throw new VaultUnreadable('the saved sign-in is missing')
      }
      const storage = cipher.storage()
      if (!storage.ok) throw new VaultUnreadable(storage.reason)
      let parsed: unknown
      try {
        parsed = JSON.parse(cipher.decrypt(data))
      } catch {
        throw new VaultUnreadable('the saved sign-in could not be decrypted')
      }
      if (!isRecord(parsed) || parsed.v !== 1 || parsed.userId !== userId) {
        throw new VaultUnreadable('the saved sign-in belongs to someone else')
      }
      if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken) {
        throw new VaultUnreadable('the saved sign-in is damaged')
      }
      return parsed.refreshToken
    },
    save(user, refreshToken) {
      if (!cipher.storage().ok) {
        clear()
        return false
      }
      // Token first: a profile is only ever written beside the token it names.
      write(tokenPath, cipher.encrypt(JSON.stringify({ v: 1, userId: user.id, refreshToken })))
      write(profilePath, JSON.stringify({ v: 1, user }))
      return true
    },
    clear,
  }
}
