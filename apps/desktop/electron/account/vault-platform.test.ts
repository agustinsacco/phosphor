import { randomBytes } from 'node:crypto'
import { fstatSync, lstatSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createVault, safeStorageCipher } from './vault'
import { fakeCipher, fakeSeal, USER } from './__fixtures__/fakes'

// These boundary tests use no filesystem, even on Windows.
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof FileSystem>()),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  closeSync: vi.fn(),
  readFileSync: vi.fn(),
  lstatSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
}))

function descriptor(regular: boolean) {
  return {
    mode: regular ? 0o100600 : 0o040600,
    uid: 0,
    size: 1,
    dev: 0,
    ino: 0,
    nlink: 1,
    gid: 0,
    rdev: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(0),
    mtime: new Date(0),
    ctime: new Date(0),
    birthtime: new Date(0),
    isFile: () => regular,
    isDirectory: () => !regular,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

describe('platform storage boundary', () => {
  it('never selects or writes a plain file off Linux, even with basic_text or no backend', async () => {
    const token = randomBytes(32).toString('base64url')
    for (const platform of ['darwin', 'win32'] as const) {
      for (const available of [false, true]) {
        for (const backend of ['basic_text', 'unknown']) {
          vi.mocked(writeFileSync).mockClear()
          const cipher = safeStorageCipher(
            {
              isAsyncEncryptionAvailable: async () => available,
              getSelectedStorageBackend: () => backend,
              encryptStringAsync: async (text) => Buffer.from(text),
              decryptStringAsync: async (data) => ({
                result: data.toString(),
                shouldReEncrypt: false,
              }),
            },
            platform,
          )
          const storage = await cipher.storage()
          expect(storage.ok && storage.kind === 'file').toBe(false)
          expect(await createVault('unused', cipher, platform).save(USER, token)).toBe(available)
          const paths = vi.mocked(writeFileSync).mock.calls.map(([path]) => String(path))
          expect(paths.every((path) => !path.includes('session.txt'))).toBe(true)
          expect(paths.length).toBe(available ? 2 : 0)
        }
      }
    }
  })
  it.each(['darwin', 'win32'] as const)(
    'refuses a file-mode cipher on %s: saves nothing and clears every file',
    async (platform) => {
      vi.mocked(lstatSync)
        .mockReset()
        .mockImplementation(() => {
          throw new Error('missing')
        })
      vi.mocked(writeFileSync).mockClear()
      vi.mocked(rmSync).mockClear()
      const vault = createVault('unused', fakeCipher({ ok: true, kind: 'file' }).cipher, platform)
      expect(await vault.save(USER, randomBytes(32).toString('base64url'))).toBe(false)
      expect(writeFileSync).not.toHaveBeenCalled()
      const removed = vi.mocked(rmSync).mock.calls.map(([path]) => String(path))
      expect(removed.some((path) => path.endsWith('session.txt'))).toBe(true)
      expect(removed.some((path) => path.endsWith('session.bin'))).toBe(true)
    },
  )
  it.each(['darwin', 'win32'] as const)(
    'ignores and removes copied plain tokens on %s, preserving encrypted tokens',
    async (platform) => {
      const { cipher } = fakeCipher()
      const secret = randomBytes(32).toString('base64url')
      const encrypted = fakeSeal(JSON.stringify({ v: 1, userId: USER.id, refreshToken: secret }))
      vi.mocked(lstatSync).mockReset().mockReturnValue(descriptor(true))
      vi.mocked(readFileSync).mockReset().mockReturnValue(Buffer.from(encrypted))
      vi.mocked(rmSync).mockClear()
      const log = vi.fn()
      const vault = createVault('unused', cipher, platform, log)
      expect(vault.savedMode()).toBe('keyring')
      expect(await vault.readToken(USER.id)).toBe(secret)
      expect(
        vi.mocked(readFileSync).mock.calls.every(([path]) => String(path).endsWith('session.bin')),
      ).toBe(true)
      expect(
        vi.mocked(rmSync).mock.calls.every(([path]) => String(path).endsWith('session.txt')),
      ).toBe(true)
      expect(rmSync).toHaveBeenCalled()
      expect(
        log.mock.calls.every(
          ([message]) => message === 'removed a plain sign-in file copied from Linux',
        ),
      ).toBe(true)
      vi.mocked(lstatSync).mockImplementation((path) => {
        if (String(path).endsWith('session.bin')) throw new Error('missing')
        return descriptor(true)
      })
      vi.mocked(readSync).mockClear()
      expect(vault.savedMode()).toBeNull()
      await expect(vault.readToken(USER.id)).rejects.toThrow(/missing/)
      expect(readSync).not.toHaveBeenCalled()
    },
  )
  it('refuses missing uid and non-regular descriptors before reading any content', async () => {
    for (const missingUid of [false, true]) {
      const stat = descriptor(missingUid)
      vi.mocked(lstatSync).mockImplementation((path) => {
        if (String(path).endsWith('session.bin')) throw new Error('missing')
        return stat
      })
      vi.mocked(fstatSync).mockReturnValue(stat)
      vi.mocked(readSync).mockClear()
      const vault = createVault(
        'unused',
        fakeCipher({ ok: true, kind: 'file' }).cipher,
        'linux',
        () => {},
        () => (missingUid ? undefined : 0),
      )
      await expect(vault.readToken(USER.id)).rejects.toThrow(/could not be read/)
      expect(readSync).not.toHaveBeenCalled()
    }
  })
})
