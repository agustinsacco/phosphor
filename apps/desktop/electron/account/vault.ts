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
  /**
   * What the last keychain check found, without starting another one: the
   * view is built synchronously and must never wait on a Keychain prompt.
   */
  storage(): Storage
  /** Never touches the keychain. On Linux, plain storage wins when both files exist. */
  savedMode(): 'keyring' | 'file' | null
  readProfile(): AccountUser | null
  /**
   * Rejects with VaultUnreadable when the token is missing, foreign or
   * unreadable. Reads the files before it first yields, so the caller may
   * clear the vault straight after calling.
   */
  readToken(userId: string): Promise<string>
  /**
   * False when storage is disabled, or when `current()` is false once the
   * keychain answers: nothing is written then.
   */
  save(user: AccountUser, refreshToken: string, current?: () => boolean): Promise<boolean>
  /** Throws, after trying every file, when any could not be deleted. */
  clear(): void
}

/** Electron's safeStorage, structurally, so this file never imports electron. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?(): string
  encryptStringAsync(text: string): Promise<Buffer>
  decryptStringAsync(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/**
 * On Linux, safeStorage "encrypts" with a hard-coded key when no keyring is
 * running (backend basic_text), so availability alone is not enough there.
 *
 * Only the async API: it never blocks the main process, even while macOS
 * shows a Keychain prompt, and it reads tokens the sync API wrote. Electron 46
 * removes the sync API. `shouldReEncrypt` is ignored: every refresh saves a
 * newly encrypted token anyway.
 */
export function safeStorageCipher(api: SafeStorageLike, platform: NodeJS.Platform): Cipher {
  const available = (): Promise<boolean> => api.isAsyncEncryptionAvailable().catch(() => false)
  return {
    async storage() {
      if (platform !== 'linux') {
        if (!(await available())) return { ok: false, reason: 'no secure storage is available' }
        return { ok: true, kind: platform === 'darwin' ? 'keychain' : 'dpapi' }
      }
      const backend = api.getSelectedStorageBackend?.() ?? 'unknown'
      // Only Chromium's own "no keyring" answer allows the file. Anything unrecognised fails closed.
      if (backend === 'basic_text') return { ok: true, kind: 'file' }
      const keyring = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)
      if (!keyring) return { ok: false, reason: 'the system keyring could not be identified' }
      if (!(await available())) return { ok: false, reason: 'the system keyring is unavailable' }
      return { ok: true, kind: backend }
    },
    encrypt: (text) => api.encryptStringAsync(text),
    decrypt: async (data) => (await api.decryptStringAsync(data)).result,
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
  let known: Storage = { ok: false, reason: 'not checked yet' }
  const checked: Cipher = {
    storage: async () => (known = await cipher.storage()),
    encrypt: (text) => cipher.encrypt(text),
    decrypt: (data) => cipher.decrypt(data),
  }
  const context: VaultContext = { paths: vaultPaths(dir), cipher: checked, platform, log, uid }
  return {
    storage: () => known,
    savedMode: () => savedTokenMode(context),
    readProfile: () => readVaultProfile(context),
    readToken: (userId) => readVaultToken(context, userId),
    save: (user, refreshToken, current) => saveVaultToken(context, user, refreshToken, current),
    clear: () => clearVaultFiles(context),
  }
}
