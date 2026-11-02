import {
  chmodSync,
  existsSync,
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
import { deferred, fakeCipher, fakeSeal, USER } from './__fixtures__/fakes'

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
    async () => {
      const vault = createVault(dir, fakeCipher().cipher)
      expect(await vault.save(USER, 'refresh-secret')).toBe(true)
      expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.bin'])
      expect(mode(dir)).toBe(0o700)
      expect(mode(join(dir, 'profile.json'))).toBe(0o600)
      expect(mode(join(dir, 'session.bin'))).toBe(0o600)
      expect(readFileSync(join(dir, 'session.bin'), 'utf8')).not.toContain('refresh-secret')
      expect(readFileSync(join(dir, 'profile.json'), 'utf8')).not.toContain('refresh')
      expect(vault.readProfile()).toEqual(USER)
      expect(await vault.readToken(USER.id)).toBe('refresh-secret')
    },
  )

  it('writes nothing, and clears an older sign-in, without secure storage', async () => {
    const { cipher, state } = fakeCipher()
    const vault = createVault(dir, cipher)
    await vault.save(USER, 'refresh-old')
    state.storage = { ok: false, reason: 'no keyring' }
    expect(await vault.save(USER, 'refresh-new')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    await expect(vault.readToken(USER.id)).rejects.toThrow(VaultUnreadable)
  })

  it('refuses a token that is missing, foreign, undecryptable or empty', async () => {
    const { cipher } = fakeCipher()
    const vault = createVault(dir, cipher)
    await expect(vault.readToken(USER.id)).rejects.toThrow('the saved sign-in is missing')
    await vault.save(USER, 'refresh-1')
    await expect(vault.readToken('someone-else')).rejects.toThrow('belongs to someone else')
    writeFileSync(join(dir, 'session.bin'), 'plain')
    await expect(vault.readToken(USER.id)).rejects.toThrow('could not be decrypted')
    const empty = JSON.stringify({ v: 1, userId: USER.id, refreshToken: '' })
    writeFileSync(join(dir, 'session.bin'), fakeSeal(empty))
    await expect(vault.readToken(USER.id)).rejects.toThrow('is damaged')
  })

  it('writes nothing when the save stopped being current while the keychain was busy', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { cipher, state } = fakeCipher(
        platform === 'linux' ? { ok: true, kind: 'file' } : { ok: true, kind: 'keychain' },
      )
      const vault = createVault(join(dir, platform), cipher, platform)
      const prompt = deferred<void>()
      state.gate = prompt.promise
      let current = true
      const saved = vault.save(USER, 'refresh-1', () => current)
      current = false // a sign-out cleared the vault meanwhile
      prompt.resolve()
      expect(await saved).toBe(false)
      expect(existsSync(join(dir, platform))).toBe(false)
    }
  })

  it('reads the token before yielding, so the files can go while the keychain is asked', async () => {
    const { cipher, state } = fakeCipher()
    const vault = createVault(dir, cipher)
    await vault.save(USER, 'refresh-1')
    const prompt = deferred<void>()
    state.gate = prompt.promise
    const read = vault.readToken(USER.id)
    vault.clear()
    expect(readdirSync(dir)).toEqual([])
    prompt.resolve()
    expect(await read).toBe('refresh-1')
  })

  it('reads a missing or damaged profile as nobody', async () => {
    const vault = createVault(dir, fakeCipher().cipher)
    expect(vault.readProfile()).toBeNull()
    await vault.save(USER, 'refresh-1')
    for (const junk of ['{', '{"v":2,"user":{"id":"x"}}', '{"v":1,"user":{"id":""}}']) {
      writeFileSync(join(dir, 'profile.json'), junk)
      expect(vault.readProfile()).toBeNull()
    }
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ v: 1, user: { id: 'x', login: 7 } }))
    expect(vault.readProfile()).toBeNull()
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ v: 1, user: { id: 'x' } }))
    expect(vault.readProfile()).toEqual({ id: 'x', login: null, name: null, email: null })
  })

  it('still deletes the token when the profile will not go, and says so', async () => {
    const vault = createVault(dir, fakeCipher().cipher)
    await vault.save(USER, 'refresh-1')
    rmSync(join(dir, 'profile.json'))
    mkdirSync(join(dir, 'profile.json', 'held'), { recursive: true })
    expect(() => vault.clear()).toThrow(/^could not delete profile\.json \(\w+\)$/)
    expect(readdirSync(dir)).toEqual(['profile.json'])
  })

  it('clears both files, and clearing nothing is fine', async () => {
    const vault = createVault(dir, fakeCipher().cipher)
    vault.clear()
    await vault.save(USER, 'refresh-1')
    vault.clear()
    expect(readdirSync(dir)).toEqual([])
    expect(vault.readProfile()).toBeNull()
  })
})

describe('safeStorageCipher', () => {
  const api = (available: boolean, backend?: string): SafeStorageLike => ({
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: backend ? () => backend : undefined,
    encryptStringAsync: async (text) => Buffer.from(text),
    decryptStringAsync: async (data) => ({ result: data.toString(), shouldReEncrypt: false }),
  })

  it('trusts the macOS Keychain and Windows DPAPI when Electron says they work', async () => {
    expect(await safeStorageCipher(api(true), 'darwin').storage()).toEqual({
      ok: true,
      kind: 'keychain',
    })
    expect(await safeStorageCipher(api(true), 'win32').storage()).toEqual({
      ok: true,
      kind: 'dpapi',
    })
    expect((await safeStorageCipher(api(false), 'darwin').storage()).ok).toBe(false)
  })

  it("uses an honest file fallback instead of Linux's hard-coded-key encryption", async () => {
    for (const available of [true, false]) {
      expect(await safeStorageCipher(api(available, 'basic_text'), 'linux').storage()).toEqual({
        ok: true,
        kind: 'file',
      })
    }
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      expect(await safeStorageCipher(api(true, backend), 'linux').storage()).toEqual({
        ok: true,
        kind: backend,
      })
      expect((await safeStorageCipher(api(false, backend), 'linux').storage()).ok).toBe(false)
    }
  })

  it('uses only the async API, so a Keychain prompt never blocks the main process', async () => {
    // A synchronous safeStorage call waits on macOS's Keychain prompt with the
    // main thread held: no window, no quit, for as long as the prompt is open.
    const calls: string[] = []
    const api = {
      isAsyncEncryptionAvailable: async () => (calls.push('available'), true),
      encryptStringAsync: async (text: string) => (calls.push('encrypt'), Buffer.from(text)),
      decryptStringAsync: async (data: Buffer) => (
        calls.push('decrypt'),
        { result: data.toString(), shouldReEncrypt: false }
      ),
      isEncryptionAvailable: () => (calls.push('sync available'), true),
      encryptString: (text: string) => (calls.push('sync encrypt'), Buffer.from(text)),
      decryptString: (data: Buffer) => (calls.push('sync decrypt'), data.toString()),
    }
    const cipher = safeStorageCipher(api as unknown as SafeStorageLike, 'darwin')
    expect(await cipher.storage()).toEqual({ ok: true, kind: 'keychain' })
    expect(await cipher.decrypt(await cipher.encrypt('secret'))).toBe('secret')
    expect(calls).toEqual(['available', 'encrypt', 'decrypt'])
  })

  it('reports no storage when the async encryptor fails to start', async () => {
    const failing: SafeStorageLike = {
      ...api(true, 'gnome_libsecret'),
      isAsyncEncryptionAvailable: () => Promise.reject(new Error('no encryptor')),
    }
    expect((await safeStorageCipher(failing, 'darwin').storage()).ok).toBe(false)
    expect((await safeStorageCipher(failing, 'linux').storage()).ok).toBe(false)
  })

  it('fails closed on a backend it cannot identify, never choosing the file', async () => {
    for (const available of [true, false]) {
      for (const backend of ['unknown', 'unrecognised', 'Basic_Text', '', undefined]) {
        expect(await safeStorageCipher(api(available, backend), 'linux').storage()).toEqual({
          ok: false,
          reason: 'the system keyring could not be identified',
        })
      }
    }
  })
})

// uid and mode bits are POSIX; file mode exists only on Linux.
describe.skipIf(process.platform === 'win32')('Linux file storage', () => {
  const plain = () => fakeCipher({ ok: true, kind: 'file' })
  const token = () => randomBytes(32).toString('base64url')
  it('saves raw at 0600 in a 0700 dir and signs out by removing all files', async () => {
    const { cipher } = plain()
    const encrypt = vi.spyOn(cipher, 'encrypt')
    mkdirSync(dir, { mode: 0o755 })
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    expect(vault.savedMode()).toBeNull()
    expect(await vault.save(USER, secret)).toBe(true)
    expect(vault.savedMode()).toBe('file')
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'session.txt'))).toBe(0o600)
    expect(readFileSync(join(dir, 'session.txt'), 'utf8')).toBe(secret)
    expect(await vault.readToken(USER.id)).toBe(secret)
    expect(encrypt).not.toHaveBeenCalled()
    vault.clear()
    expect(readdirSync(dir)).toEqual([])
  })
  it.each(['permissions', 'symlink', 'owner', 'directory', 'oversized', 'empty', 'foreign'])(
    'refuses and removes %s without disclosing contents',
    async (unsafe) => {
      const log = vi.fn()
      const owner = process.getuid?.()
      const vault = createVault(dir, plain().cipher, 'linux', log, () =>
        unsafe === 'owner' ? (owner ?? 0) + 1 : owner,
      )
      const secret = token()
      await vault.save(USER, secret)
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
      await expect(vault.readToken(unsafe === 'foreign' ? 'foreign' : USER.id)).rejects.toThrow()
      expect(readdirSync(dir)).not.toContain('session.txt')
      expect(log).toHaveBeenCalledExactlyOnceWith('removed an unsafe or unreadable sign-in file')
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
      if (unsafe === 'symlink') expect(readFileSync(join(root, 'target'), 'utf8')).toBe(secret)
    },
  )
  it('accepts exactly 4 KB but rejects one byte more on save, with no temp files', async () => {
    const vault = createVault(dir, plain().cipher, 'linux')
    const boundary = randomBytes(2048).toString('hex')
    await vault.save(USER, boundary)
    expect(await vault.readToken(USER.id)).toBe(boundary)
    await expect(vault.save(USER, boundary + 'x')).rejects.toThrow(/too large/)
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.txt'])
  })
  it('removes the temp on rename failure', async () => {
    mkdirSync(join(dir, 'session.txt'), { recursive: true })
    const vault = createVault(dir, plain().cipher, 'linux')
    await expect(vault.save(USER, token())).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['session.txt'])
  })
  it('migrates file to keyring on save, and prefers encrypted when both exist', async () => {
    const { cipher, state } = plain()
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    await vault.save(USER, secret)
    state.storage = { ok: true, kind: 'gnome_libsecret' }
    await vault.save(USER, secret)
    expect(vault.savedMode()).toBe('keyring')
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.bin'])
    expect(readFileSync(join(dir, 'session.bin'), 'utf8')).not.toContain(secret)
    writeFileSync(join(dir, 'session.txt'), token(), { mode: 0o600 })
    expect(vault.savedMode()).toBe('file')
    expect(await vault.readToken(USER.id)).toBe(secret)
    expect(vault.savedMode()).toBe('keyring')
  })
  it('never replaces readable encrypted tokens with plain files', async () => {
    const { cipher, state } = fakeCipher()
    const vault = createVault(dir, cipher, 'linux')
    const secret = token()
    await vault.save(USER, secret)
    state.storage = { ok: true, kind: 'file' }
    expect(await vault.readToken(USER.id)).toBe(secret)
    await expect(vault.save(USER, token())).rejects.toThrow(/refused to replace/)
    expect(vault.savedMode()).toBe('keyring')
    expect(await vault.readToken(USER.id)).toBe(secret)
  })
  it('removes dead encrypted tokens before file save, with a content-free log', async () => {
    const log = vi.fn()
    const { cipher } = plain()
    mkdirSync(dir)
    writeFileSync(join(dir, 'session.bin'), randomBytes(32))
    const vault = createVault(dir, cipher, 'linux', log)
    await vault.save(USER, token())
    expect(readdirSync(dir).sort()).toEqual(['profile.json', 'session.txt'])
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'removed an unreadable encrypted sign-in; no keyring is running',
    )
  })
})

it('preserves readable encrypted storage when plain-file cleanup fails', async () => {
  const { cipher, state } = fakeCipher()
  const vault = createVault(dir, cipher, 'linux')
  await vault.save(USER, randomBytes(32).toString('base64url'))
  state.storage = { ok: true, kind: 'file' }
  mkdirSync(join(dir, 'session.txt', 'held'), { recursive: true })
  await expect(vault.readToken(USER.id)).rejects.toThrow()
  expect(readdirSync(dir)).toContain('session.bin')
  expect(vault.savedMode()).toBe('file')
})

it('does not touch the keychain when the remembered credential file is absent', async () => {
  const { cipher } = fakeCipher()
  const storage = vi.spyOn(cipher, 'storage')
  const decrypt = vi.spyOn(cipher, 'decrypt')
  const vault = createVault(dir, cipher)
  await expect(vault.readToken(USER.id)).rejects.toThrow('the saved sign-in is missing')
  expect(storage).not.toHaveBeenCalled()
  expect(decrypt).not.toHaveBeenCalled()
})
