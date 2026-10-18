import type { AccountUser } from './gotrue'
import { clearVaultFiles, vaultPaths } from './vault-files'
import {
  readVaultProfile,
  readVaultToken,
  savedTokenMode,
  saveVaultToken,
  type Cipher,
  type Storage,
  type VaultContext,
} from './vault-token'

export { VaultUnreadable, type Cipher, type Storage } from './vault-token'

/**
 * Where a remembered sign-in lives: the refresh token encrypted by the OS
 * (macOS Keychain, Windows DPAPI, Linux Secret Service or KWallet), and a
 * user-only plain token on Linux without a keyring. A plain profile lets startup
 * say who is signed in without touching the keychain. Nothing here ever reaches
 * electron-store, a log or the renderer.
 */

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

/** Builds the vault's context and binds the file and token operations to it. */
export function createVault(
  dir: string,
  cipher: Cipher,
  platform: NodeJS.Platform = process.platform,
  log: (message: string) => void = () => {},
  uid: () => number | undefined = () => process.getuid?.(),
): Vault {
  const context: VaultContext = { paths: vaultPaths(dir), cipher, platform, log, uid }
  return {
    storage: () => cipher.storage(),
    savedMode: () => savedTokenMode(context),
    readProfile: () => readVaultProfile(context),
    readToken: (userId) => readVaultToken(context, userId),
    save: (user, refreshToken) => saveVaultToken(context, user, refreshToken),
    clear: () => clearVaultFiles(context),
  }
}
