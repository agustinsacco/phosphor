import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, safeStorageCipher, VaultUnreadable, type SafeStorageLike } from './vault'
import { fakeCipher, USER } from './__fixtures__/fakes'

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phx-vault-'))
  dir = join(root, 'account')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mode = (path: string) => statSync(path).mode & 0o777

describe('createVault', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps a session in two files only the user can read, the token encrypted',
    () => {
      const vault = createVault(dir, fakeCipher().cipher)
      expect(vault.save(USER, 'refresh-secret')).toBe(true)
      expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.bin'])
      expect(mode(dir)).toBe(0o700)
      expect(mode(join(dir, 'profile.json'))).toBe(0o600)
      expect(mode(join(dir, 'session.bin'))).toBe(0o600)
      expect(readFileSync(join(dir, 'session.bin'), 'utf8')).not.toContain('refresh-secret')
      expect(readFileSync(join(dir, 'profile.json'), 'utf8')).not.toContain('refresh')
      expect(vault.readProfile()).toEqual(USER)
      expect(vault.readToken(USER.id)).toBe('refresh-secret')
    },
  )

  it('writes nothing, and clears an older sign-in, without secure storage', () => {
    const { cipher, state } = fakeCipher()
    const vault = createVault(dir, cipher)
    vault.save(USER, 'refresh-old')
    state.storage = { ok: false, reason: 'no keyring' }
    expect(vault.save(USER, 'refresh-new')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    expect(() => vault.readToken(USER.id)).toThrow(VaultUnreadable)
  })

  it('refuses a token that is missing, foreign, undecryptable or empty', () => {
    const { cipher } = fakeCipher()
    const vault = createVault(dir, cipher)
    expect(() => vault.readToken(USER.id)).toThrow('the saved sign-in is missing')
    vault.save(USER, 'refresh-1')
    expect(() => vault.readToken('someone-else')).toThrow('belongs to someone else')
    writeFileSync(join(dir, 'session.bin'), 'plain')
    expect(() => vault.readToken(USER.id)).toThrow('could not be decrypted')
    const empty = JSON.stringify({ v: 1, userId: USER.id, refreshToken: '' })
    writeFileSync(join(dir, 'session.bin'), cipher.encrypt(empty))
    expect(() => vault.readToken(USER.id)).toThrow('is damaged')
  })

  it('reads a missing or damaged profile as nobody', () => {
    const vault = createVault(dir, fakeCipher().cipher)
    expect(vault.readProfile()).toBeNull()
    vault.save(USER, 'refresh-1')
    for (const junk of ['{', '{"v":2,"user":{"id":"x"}}', '{"v":1,"user":{"id":""}}']) {
      writeFileSync(join(dir, 'profile.json'), junk)
      expect(vault.readProfile()).toBeNull()
    }
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ v: 1, user: { id: 'x', login: 7 } }))
    expect(vault.readProfile()).toBeNull()
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ v: 1, user: { id: 'x' } }))
    expect(vault.readProfile()).toEqual({ id: 'x', login: null, name: null, email: null })
  })

  it('still deletes the token when the profile will not go, and says so', () => {
    const vault = createVault(dir, fakeCipher().cipher)
    vault.save(USER, 'refresh-1')
    rmSync(join(dir, 'profile.json'))
    mkdirSync(join(dir, 'profile.json', 'held'), { recursive: true })
    expect(() => vault.clear()).toThrow(/^could not delete profile\.json \(\w+\)$/)
    expect(readdirSync(dir)).toEqual(['profile.json'])
  })

  it('clears both files, and clearing nothing is fine', () => {
    const vault = createVault(dir, fakeCipher().cipher)
    vault.clear()
    vault.save(USER, 'refresh-1')
    vault.clear()
    expect(readdirSync(dir)).toEqual([])
    expect(vault.readProfile()).toBeNull()
  })
})

describe('safeStorageCipher', () => {
  const api = (available: boolean, backend?: string): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: backend ? () => backend : undefined,
    encryptString: (text) => Buffer.from(text),
    decryptString: (data) => data.toString(),
  })

  it('trusts the macOS Keychain and Windows DPAPI when Electron says they work', () => {
    expect(safeStorageCipher(api(true), 'darwin').storage()).toEqual({ ok: true, kind: 'keychain' })
    expect(safeStorageCipher(api(true), 'win32').storage()).toEqual({ ok: true, kind: 'dpapi' })
    expect(safeStorageCipher(api(false), 'darwin').storage().ok).toBe(false)
  })

  it("refuses Linux's hard-coded-key fallback and an unknown backend", () => {
    for (const backend of ['basic_text', 'unknown', undefined]) {
      const storage = safeStorageCipher(api(true, backend), 'linux').storage()
      expect(storage).toEqual({ ok: false, reason: expect.stringMatching(/keyring/) })
    }
    const keyring = safeStorageCipher(api(true, 'gnome_libsecret'), 'linux').storage()
    expect(keyring).toEqual({ ok: true, kind: 'gnome_libsecret' })
  })
})
