import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import type * as FileSystem from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultPaths } from './vault-files'
import {
  readVaultProfile,
  readVaultToken,
  savedTokenMode,
  saveVaultToken,
  VaultUnreadable,
  type Storage,
  type VaultContext,
} from './vault-token'
import { fakeCipher, fakeSeal, USER } from './__fixtures__/fakes'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>()
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  }
})
const real = await vi.importActual<typeof FileSystem>('node:fs')

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phx-vault-token-'))
  dir = join(root, 'account')
})
afterEach(() => {
  vi.resetAllMocks()
  real.rmSync(root, { recursive: true, force: true })
})

const token = () => randomBytes(32).toString('base64url')
const owner = process.getuid?.()
const file = (name: string) => join(dir, name)
const listed = () => readdirSync(dir).sort()
const PROFILE = JSON.stringify({ v: 1, user: USER })

function vault(storage: Storage = { ok: true, kind: 'file' }, platform: NodeJS.Platform = 'linux') {
  const fake = fakeCipher(storage)
  const log = vi.fn()
  const context: VaultContext = {
    paths: vaultPaths(dir),
    cipher: fake.cipher,
    platform,
    log,
    uid: () => owner,
  }
  return { context, log, ...fake }
}

function seed(files: Record<string, string | Buffer>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(file(name), data)
    chmodSync(file(name), 0o600)
  }
  vi.clearAllMocks()
}

const sealed = (userId: string, refreshToken: string) =>
  fakeSeal(JSON.stringify({ v: 1, userId, refreshToken }))

describe('readVaultProfile', () => {
  it('keeps only a GitHub avatar, and reads anything else as no profile', async () => {
    const avatar = 'https://avatars.githubusercontent.com/u/1?v=4'
    seed({ 'profile.json': JSON.stringify({ v: 1, user: { ...USER, avatarUrl: avatar } }) })
    expect(readVaultProfile(vault().context)).toEqual({ ...USER, avatarUrl: avatar })
    seed({ 'profile.json': JSON.stringify({ v: 1, user: { ...USER, avatarUrl: 'http://x/a' } }) })
    expect(readVaultProfile(vault().context)).toEqual(USER)
    seed({ 'profile.json': JSON.stringify({ v: 1, user: { ...USER, email: 7 } }) })
    expect(readVaultProfile(vault().context)).toBeNull()
  })
})

describe('savedTokenMode', () => {
  it('reads presence only, preferring plain on Linux and ignoring it elsewhere', async () => {
    seed({ 'session.bin': 'x', 'session.txt': 'x' })
    const linux = vault({ ok: true, kind: 'gnome_libsecret' })
    const storage = vi.spyOn(linux.cipher, 'storage')
    expect(savedTokenMode(linux.context)).toBe('file')
    expect(savedTokenMode(vault(undefined, 'darwin').context)).toBe('keyring')
    expect(listed()).toEqual(['session.bin'])
    expect(storage).not.toHaveBeenCalled()
    expect(linux.state.decrypts).toBe(0)
  })
})

// uid and mode bits are POSIX.
describe.skipIf(process.platform === 'win32')('readVaultToken', () => {
  it('binds an encrypted token to its user, and a plain one to the saved profile', async () => {
    const secret = token()
    seed({ 'session.bin': sealed(USER.id, secret) })
    const keyring = vault({ ok: true, kind: 'kwallet5' })
    expect(await readVaultToken(keyring.context, USER.id)).toBe(secret)
    await expect(readVaultToken(keyring.context, 'someone-else')).rejects.toThrow(
      new VaultUnreadable('the saved sign-in belongs to someone else'),
    )
    expect(listed()).toEqual(['session.bin'])

    real.rmSync(dir, { recursive: true })
    seed({ 'profile.json': PROFILE, 'session.txt': token() })
    const plain = vault()
    await expect(readVaultToken(plain.context, 'someone-else')).rejects.toThrow(
      new VaultUnreadable('the saved sign-in file could not be read'),
    )
    expect(readSync).toHaveBeenCalled()
    expect(listed()).toEqual(['profile.json'])
    expect(plain.log.mock.calls).toEqual([['removed an unsafe or unreadable sign-in file']])
  })

  it('reads the plain token from its one validated descriptor, never by path again', async () => {
    const secret = token()
    seed({ 'profile.json': PROFILE, 'session.txt': secret })
    expect(await readVaultToken(vault().context, USER.id)).toBe(secret)
    expect(openSync).toHaveBeenCalledOnce()
    const fd = vi.mocked(openSync).mock.results[0]?.value
    expect(vi.mocked(fstatSync).mock.calls).toEqual([[fd]])
    expect(vi.mocked(readSync).mock.calls.every(([used]) => used === fd)).toBe(true)
    expect(vi.mocked(closeSync).mock.calls).toEqual([[fd]])
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => path)).toEqual([file('profile.json')])
  })

  it('refuses a plain token that outgrew its fstat size, reading no more than 4097 bytes', async () => {
    for (const size of [4097, 1_000_000]) {
      seed({ 'profile.json': PROFILE, 'session.txt': 'a'.repeat(size) })
      vi.mocked(fstatSync).mockImplementationOnce((fd) => {
        const stat = real.fstatSync(fd)
        stat.size = 4096
        return stat
      })
      const { context, log } = vault()
      await expect(readVaultToken(context, USER.id)).rejects.toThrow(
        new VaultUnreadable('the saved sign-in file could not be read'),
      )
      const read = vi.mocked(readSync).mock.results.map(({ value }) => value as number)
      expect(read.reduce((sum, count) => sum + count, 0)).toBe(4097)
      expect(listed()).toEqual(['profile.json'])
      expect(log.mock.calls).toEqual([['removed an unsafe or unreadable sign-in file']])
    }
  })

  it('falls back from a dead encrypted token to the plain one only without a keyring', async () => {
    const plain = token()
    seed({ 'profile.json': PROFILE, 'session.bin': 'junk', 'session.txt': plain })
    await expect(
      readVaultToken(vault({ ok: true, kind: 'kwallet' }).context, USER.id),
    ).rejects.toThrow(new VaultUnreadable('the saved sign-in could not be decrypted'))
    expect(listed()).toEqual(['profile.json', 'session.bin', 'session.txt'])
    const { context, log } = vault()
    expect(await readVaultToken(context, USER.id)).toBe(plain)
    expect(listed()).toEqual(['profile.json', 'session.txt'])
    expect(log.mock.calls).toEqual([
      ['removed an unreadable encrypted sign-in; no keyring is running'],
    ])
  })

  it('off Linux reads only the encrypted token, removing a plain copy first', async () => {
    seed({ 'profile.json': PROFILE, 'session.txt': token() })
    const { context, log } = vault({ ok: true, kind: 'file' }, 'win32')
    await expect(readVaultToken(context, USER.id)).rejects.toThrow(
      new VaultUnreadable('the saved sign-in is missing'),
    )
    expect(openSync).not.toHaveBeenCalled()
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([['removed a plain sign-in file copied from Linux']])
  })

  it('reports why storage is unavailable once a token is present', async () => {
    const { context } = vault({ ok: false, reason: 'no secure storage is available' })
    await expect(readVaultToken(context, USER.id)).rejects.toThrow(
      new VaultUnreadable('the saved sign-in is missing'),
    )
    seed({ 'session.bin': sealed(USER.id, token()) })
    await expect(readVaultToken(context, USER.id)).rejects.toThrow(
      new VaultUnreadable('no secure storage is available'),
    )
  })
})

describe.skipIf(process.platform === 'win32')('saveVaultToken', () => {
  it('refuses to downgrade a readable encrypted token to a plain file', async () => {
    const before = sealed(USER.id, token())
    seed({ 'profile.json': PROFILE, 'session.bin': before })
    const { context, log } = vault()
    await expect(saveVaultToken(context, { ...USER, name: 'New' }, token())).rejects.toThrow(
      new VaultUnreadable('refused to replace a readable encrypted sign-in with a file'),
    )
    expect(listed()).toEqual(['profile.json', 'session.bin'])
    expect(readFileSync(file('session.bin'))).toEqual(before)
    expect(readVaultProfile(context)).toEqual(USER)
    expect(log).not.toHaveBeenCalled()
  })

  it('upgrades a plain token to the keyring, removing the plain file', async () => {
    const secret = token()
    seed({ 'profile.json': PROFILE, 'session.txt': token() })
    const { context, state } = vault({ ok: true, kind: 'gnome_libsecret' })
    expect(await saveVaultToken(context, USER, secret)).toBe(true)
    expect(listed()).toEqual(['profile.json', 'session.bin'])
    expect(await readVaultToken(context, USER.id)).toBe(secret)
    expect(state.decrypts).toBe(1)
  })

  it('saves nothing and clears everything when storage is off or a file cipher is off Linux', async () => {
    const off: [Storage, NodeJS.Platform][] = [
      [{ ok: false, reason: 'no keyring' }, 'linux'],
      [{ ok: true, kind: 'file' }, 'darwin'],
    ]
    for (const [storage, platform] of off) {
      seed({ 'profile.json': PROFILE, 'session.bin': 'x', 'session.txt': 'x', 'avatar.json': 'x' })
      expect(await saveVaultToken(vault(storage, platform).context, USER, token())).toBe(false)
      expect(listed()).toEqual([])
    }
  })
})
