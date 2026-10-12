import {
  chmodSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it("uses an honest file fallback instead of Linux's hard-coded-key encryption", () => {
    for (const backend of ['basic_text', 'unknown', 'unrecognised', undefined]) {
      const storage = safeStorageCipher(api(true, backend), 'linux').storage()
      expect(storage).toEqual({ ok: true, kind: 'file' })
    }
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      expect(safeStorageCipher(api(true, backend), 'linux').storage()).toEqual({
        ok: true,
        kind: backend,
      })
      expect(safeStorageCipher(api(false, backend), 'linux').storage().ok).toBe(false)
    }
    expect(safeStorageCipher(api(false, 'unknown'), 'linux').storage()).toEqual({
      ok: true,
      kind: 'file',
    })
  })
})

// uid and mode bits are POSIX; file mode exists only on Linux.
describe.skipIf(process.platform === 'win32')('Linux file storage', () => {
  const plain = () => fakeCipher({ ok: true, kind: 'file' })
  const token = () => randomBytes(32).toString('base64url')
  it('saves raw at 0600 in a 0700 dir and signs out by removing all files', () => {
    const { cipher } = plain()
    const encrypt = vi.spyOn(cipher, 'encrypt')
    mkdirSync(dir, { mode: 0o755 })
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    expect(vault.savedMode()).toBeNull()
    expect(vault.save(USER, secret)).toBe(true)
    expect(vault.savedMode()).toBe('file')
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'session.txt'))).toBe(0o600)
    expect(readFileSync(join(dir, 'session.txt'), 'utf8')).toBe(secret)
    expect(vault.readToken(USER.id)).toBe(secret)
    expect(encrypt).not.toHaveBeenCalled()
    vault.clear()
    expect(readdirSync(dir)).toEqual([])
  })
  it.each(['permissions', 'symlink', 'owner', 'directory', 'oversized', 'empty', 'foreign'])(
    'refuses and removes %s without disclosing contents',
    (unsafe) => {
      const log = vi.fn()
      const owner = process.getuid?.()
      const vault = createVault(dir, plain().cipher, 'linux', log, () =>
        unsafe === 'owner' ? (owner ?? 0) + 1 : owner,
      )
      const secret = token()
      vault.save(USER, secret)
      const path = join(dir, 'session.txt')
      if (unsafe === 'permissions') chmodSync(path, 0o644)
      if (unsafe === 'symlink') {
        rmSync(path)
        writeFileSync(join(root, 'target'), secret, { mode: 0o600 })
        symlinkSync(join(root, 'target'), path)
      }
      if (unsafe === 'directory') {
        rmSync(path)
        mkdirSync(path)
      }
      if (unsafe === 'oversized') writeFileSync(path, randomBytes(4097))
      if (unsafe === 'empty') writeFileSync(path, '')
      expect(() => vault.readToken(unsafe === 'foreign' ? 'foreign' : USER.id)).toThrow()
      expect(readdirSync(dir)).not.toContain('session.txt')
      expect(log).toHaveBeenCalledExactlyOnceWith('removed an unsafe or unreadable sign-in file')
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
      if (unsafe === 'symlink') expect(readFileSync(join(root, 'target'), 'utf8')).toBe(secret)
    },
  )
  it('accepts exactly 4 KB but rejects one byte more on save, with no temp files', () => {
    const vault = createVault(dir, plain().cipher, 'linux')
    const boundary = randomBytes(2048).toString('hex')
    vault.save(USER, boundary)
    expect(vault.readToken(USER.id)).toBe(boundary)
    expect(() => vault.save(USER, boundary + 'x')).toThrow(/too large/)
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.txt'])
  })
  it('removes the temp on rename failure', () => {
    mkdirSync(join(dir, 'session.txt'), { recursive: true })
    const vault = createVault(dir, plain().cipher, 'linux')
    expect(() => vault.save(USER, token())).toThrow()
    expect(readdirSync(dir)).toEqual(['session.txt'])
  })
  it('migrates file to keyring on save, and prefers encrypted when both exist', () => {
    const { cipher, state } = plain()
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    vault.save(USER, secret)
    state.storage = { ok: true, kind: 'gnome_libsecret' }
    vault.save(USER, secret)
    expect(vault.savedMode()).toBe('keyring')
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.bin'])
    expect(readFileSync(join(dir, 'session.bin'), 'utf8')).not.toContain(secret)
    writeFileSync(join(dir, 'session.txt'), token(), { mode: 0o600 })
    expect(vault.savedMode()).toBe('file')
    expect(vault.readToken(USER.id)).toBe(secret)
    expect(vault.savedMode()).toBe('keyring')
  })
  it('never replaces readable encrypted tokens with plain files', () => {
    const { cipher, state } = fakeCipher()
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    vault.save(USER, secret)
    state.storage = { ok: true, kind: 'file' }
    expect(vault.readToken(USER.id)).toBe(secret)
    expect(() => vault.save(USER, token())).toThrow(/refused to replace/)
    expect(vault.savedMode()).toBe('keyring')
    expect(vault.readToken(USER.id)).toBe(secret)
  })
  it('removes dead encrypted tokens before file save, with a content-free log', () => {
    const log = vi.fn()
    const { cipher } = plain()
    mkdirSync(dir)
    writeFileSync(join(dir, 'session.bin'), randomBytes(32))
    const vault = createVault(dir, cipher, 'linux', log)
    vault.save(USER, token())
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.txt'])
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'removed an unreadable encrypted sign-in; no keyring is running',
    )
  })
})

it('preserves readable encrypted storage when plain-file cleanup fails', () => {
  const { cipher, state } = fakeCipher()
  const vault = createVault(dir, cipher, 'linux')
  vault.save(USER, randomBytes(32).toString('base64url'))
  state.storage = { ok: true, kind: 'file' }
  mkdirSync(join(dir, 'session.txt', 'held'), { recursive: true })
  expect(() => vault.readToken(USER.id)).toThrow()
  expect(readdirSync(dir)).toContain('session.bin')
  expect(vault.savedMode()).toBe('file')
})
