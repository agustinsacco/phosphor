import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type * as FileSystem from 'node:fs'
import { randomBytes } from 'node:crypto'
import type * as Crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearVaultFiles,
  removeCopiedPlain,
  removeUnsafePlain,
  vaultFileExists,
  vaultPaths,
  writeVaultFile,
  type VaultFileContext,
} from './vault-files'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})
const real = await vi.importActual<typeof FileSystem>('node:fs')

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phx-vault-files-'))
  dir = join(root, 'account')
})
afterEach(() => {
  vi.resetAllMocks()
  real.rmSync(root, { recursive: true, force: true })
})

const mode = (path: string) => statSync(path).mode & 0o777

function context(platform: NodeJS.Platform = 'linux') {
  const log = vi.fn()
  const files: VaultFileContext = { paths: vaultPaths(dir), platform, log }
  return { files, log }
}

const fsError = (code: string) => Object.assign(new Error(`fake ${code}`), { code })

describe('vaultPaths', () => {
  it('names the profile, encrypted and plain token files inside the directory', () => {
    expect(vaultPaths('/vault')).toEqual({
      dir: '/vault',
      profile: join('/vault', 'profile.json'),
      token: join('/vault', 'session.bin'),
      plain: join('/vault', 'session.txt'),
    })
  })
})

// File modes and links are POSIX.
describe.skipIf(process.platform === 'win32')('writeVaultFile', () => {
  it('writes through a 0600 temp in a 0700 directory, tightening one that was open', () => {
    mkdirSync(dir, { mode: 0o755 })
    const { files } = context()
    writeVaultFile(files, files.paths.profile, 'first')
    writeVaultFile(files, files.paths.profile, Buffer.from('second'))
    expect(mode(dir)).toBe(0o700)
    expect(mode(files.paths.profile)).toBe(0o600)
    expect(readFileSync(files.paths.profile, 'utf8')).toBe('second')
    expect(readdirSync(dir)).toEqual(['profile.json'])
    for (const [temp, , options] of vi.mocked(writeFileSync).mock.calls) {
      expect(String(temp)).toMatch(/[/\\]profile\.json\.[0-9a-f]{12}\.tmp$/)
      expect(options).toEqual({ mode: 0o600, flag: 'wx' })
    }
    expect(vi.mocked(renameSync).mock.calls.map(([, to]) => to)).toEqual([
      files.paths.profile,
      files.paths.profile,
    ])
  })

  it('never writes through a planted temp link, and leaves its target alone', () => {
    const { files } = context()
    mkdirSync(dir, { mode: 0o700 })
    vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(6))
    const target = join(root, 'target')
    writeFileSync(target, 'theirs')
    symlinkSync(target, `${files.paths.plain}.000000000000.tmp`)
    expect(() => writeVaultFile(files, files.paths.plain, 'secret')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    )
    expect(readFileSync(target, 'utf8')).toBe('theirs')
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes the temp and rethrows when the rename fails', () => {
    const { files } = context()
    mkdirSync(join(files.paths.token, 'held'), { recursive: true })
    expect(() => writeVaultFile(files, files.paths.token, 'sealed')).toThrow()
    expect(readdirSync(dir)).toEqual(['session.bin'])
    expect(vi.mocked(rmSync).mock.calls).toEqual([
      [vi.mocked(writeFileSync).mock.calls[0]?.[0], { force: true }],
    ])
  })

  it('removes the temp and rethrows when the write fails', () => {
    const { files } = context()
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw fsError('ENOSPC')
    })
    expect(() => writeVaultFile(files, files.paths.plain, 'secret')).toThrow(
      expect.objectContaining({ code: 'ENOSPC' }),
    )
    expect(renameSync).not.toHaveBeenCalled()
    expect(rmSync).toHaveBeenCalledOnce()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('clearVaultFiles', () => {
  it('is fine with nothing to clear, and removes the avatar too', () => {
    const { files } = context()
    clearVaultFiles(files)
    mkdirSync(dir)
    for (const name of ['session.bin', 'session.txt', 'profile.json', 'avatar.json', 'other'])
      writeFileSync(join(dir, name), 'x')
    clearVaultFiles(files)
    expect(readdirSync(dir)).toEqual(['other'])
  })

  it('attempts every file, the credentials first, and names each failure', () => {
    const { files } = context()
    vi.mocked(rmSync).mockImplementation((path) => {
      if (String(path).endsWith('session.txt')) throw fsError('EBUSY')
      if (String(path).endsWith('avatar.json')) throw new Error('no code')
    })
    expect(() => clearVaultFiles(files)).toThrow(
      new Error('could not delete session.txt (EBUSY) and avatar.json (error)'),
    )
    expect(vi.mocked(rmSync).mock.calls.map(([path]) => String(path))).toEqual([
      files.paths.token,
      files.paths.plain,
      files.paths.profile,
      join(dir, 'avatar.json'),
    ])
  })
})

describe.skipIf(process.platform === 'win32')('vaultFileExists', () => {
  it('sees a file, a directory and a dangling link, and nothing for a missing path', () => {
    mkdirSync(join(dir, 'folder'), { recursive: true })
    writeFileSync(join(dir, 'file'), 'x')
    symlinkSync(join(root, 'nowhere'), join(dir, 'link'))
    expect(
      ['file', 'folder', 'link', 'missing'].map((name) => vaultFileExists(join(dir, name))),
    ).toEqual([true, true, true, false])
  })
})

describe.skipIf(process.platform === 'win32')('removeCopiedPlain', () => {
  it('keeps a plain token on Linux', () => {
    const { files, log } = context('linux')
    mkdirSync(dir)
    writeFileSync(files.paths.plain, 'secret')
    removeCopiedPlain(files)
    expect(readdirSync(dir)).toEqual(['session.txt'])
    expect(log).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32', 'freebsd'] as const)(
    'removes a copied plain token on %s, saying so without its contents',
    (platform) => {
      const { files, log } = context(platform)
      removeCopiedPlain(files)
      expect(rmSync).not.toHaveBeenCalled()
      mkdirSync(dir)
      writeFileSync(files.paths.plain, 'secret')
      removeCopiedPlain(files)
      expect(readdirSync(dir)).toEqual([])
      expect(log.mock.calls).toEqual([['removed a plain sign-in file copied from Linux']])
    },
  )
})

describe.skipIf(process.platform === 'win32')('removeUnsafePlain', () => {
  it('removes a file, an empty directory or a link, never a link target', () => {
    const { files } = context()
    expect(removeUnsafePlain(files)).toBe(true)
    mkdirSync(dir)
    writeFileSync(files.paths.plain, 'x')
    expect(removeUnsafePlain(files)).toBe(true)
    mkdirSync(files.paths.plain)
    expect(removeUnsafePlain(files)).toBe(true)
    writeFileSync(join(root, 'target'), 'theirs')
    symlinkSync(join(root, 'target'), files.paths.plain)
    expect(removeUnsafePlain(files)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('theirs')
  })

  it('answers false, without throwing, when the path will not go', () => {
    const { files, log } = context()
    mkdirSync(join(files.paths.plain, 'held'), { recursive: true })
    expect(removeUnsafePlain(files)).toBe(false)
    expect(readdirSync(dir)).toEqual(['session.txt'])
    expect(log).not.toHaveBeenCalled()
  })
})
