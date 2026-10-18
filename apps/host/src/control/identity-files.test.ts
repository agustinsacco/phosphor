import { constants, type PathLike } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkIdentityDirectory,
  cleanHostKeys,
  ensureIdentityDirectory,
  existingIdentityDirectory,
  identityEntryExists,
  isMissing,
  readIdentityFile,
  readIdentityFileSnapshot,
  removeIdentityFile,
  writeIdentityFileAtomic,
} from './identity-files'
import { IdentityFailure } from './identity-records'
import type { IdentityLocation } from './identity-types'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    unlink: vi.fn(actual.unlink),
  }
})
const actualFs = await vi.importActual<typeof filesystem>('node:fs/promises')

const UNSAFE = /^Unsafe identity storage\./
const uid = process.getuid?.()
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const otherId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01'
let root: string
let dir: string
const events: string[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-identity-files-'))
  dir = join(root, 'identity')
  await mkdir(dir, { mode: 0o700 })
  events.length = 0
})
afterEach(async () => {
  vi.mocked(filesystem.open).mockReset()
  vi.mocked(filesystem.lstat).mockReset()
  vi.mocked(filesystem.unlink).mockReset()
  await rm(root, { recursive: true, force: true })
})
const denied = () => Object.assign(new Error('denied'), { code: 'EACCES' })
const temps = async () => (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
const name = (path: PathLike) => {
  const base = String(path).slice(dir.length + 1)
  return /^\.host-[0-9a-f-]{36}\.tmp$/.test(base) ? 'TMP' : base
}
const location = (rename = actualFs.rename): IdentityLocation => ({
  directory: dir,
  uid,
  ports: {
    rename: async (from, to) => {
      events.push(`rename ${name(from)} ${name(to)}`)
      await rename(from, to)
    },
  },
})
/** Trace the descriptor calls of every file the module opens. `fail` makes one method throw. */
function traceHandles(fail?: 'writeFile' | 'sync') {
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actualFs.open(path, flags, mode)
    events.push(`open ${name(path)} ${String(flags)} ${typeof mode === 'number' ? mode : '-'}`)
    const writing = handle.writeFile.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementation(async (data) => {
      events.push('writeFile')
      if (fail === 'writeFile') throw denied()
      await writing(data)
    })
    const sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      events.push('sync')
      if (fail === 'sync') throw denied()
      await sync()
    })
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      events.push('close')
      await close()
    })
    return handle
  })
  vi.mocked(filesystem.unlink).mockImplementation(async (path) => {
    events.push(`unlink ${name(path)}`)
    await actualFs.unlink(path)
  })
}

describe('identity file reads', () => {
  it('opens read-only, without following symlinks or blocking, and returns the descriptor stat', async () => {
    await writeFile(join(dir, 'host.json'), 'text', { mode: 0o600 })
    const snapshot = await readIdentityFileSnapshot(dir, uid, 'host.json')
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    expect(vi.mocked(filesystem.open).mock.calls).toEqual([[join(dir, 'host.json'), flags]])
    expect(snapshot.text).toBe('text')
    expect(snapshot.info.ino).toBe((await actualFs.lstat(join(dir, 'host.json'))).ino)
    expect(await readIdentityFile(dir, uid, 'host.json')).toBe('text')
  })

  it('reads 4096 bytes and refuses a 4097th, by stat or by read', async () => {
    const path = join(dir, 'host.json')
    await writeFile(path, 'x'.repeat(4096), { mode: 0o600 })
    expect(await readIdentityFile(dir, uid, 'host.json')).toHaveLength(4096)
    await writeFile(path, 'x'.repeat(4097))
    await expect(readIdentityFile(dir, uid, 'host.json')).rejects.toThrow(UNSAFE)
    vi.mocked(filesystem.open).mockImplementation(async (target, flags, mode) => {
      const handle = await actualFs.open(target, flags, mode)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementation(async () =>
        Object.assign(await stat(), { size: 4096 }),
      )
      return handle
    })
    await expect(readIdentityFile(dir, uid, 'host.json')).rejects.toThrow(UNSAFE)
  })

  it('refuses a symlink, a directory or a loose file before opening it', async () => {
    await writeFile(join(root, 'outside'), 'x', { mode: 0o600 })
    await symlink(join(root, 'outside'), join(dir, 'link'))
    await mkdir(join(dir, 'folder'), { mode: 0o700 })
    await writeFile(join(dir, 'loose'), 'x', { mode: 0o640 })
    for (const target of ['link', 'folder', 'loose'])
      await expect(readIdentityFile(dir, uid, target)).rejects.toThrow(UNSAFE)
    expect(vi.mocked(filesystem.open)).not.toHaveBeenCalled()
  })

  it('refuses a descriptor that no longer matches what lstat saw', async () => {
    await writeFile(join(dir, 'host.json'), 'x', { mode: 0o600 })
    vi.mocked(filesystem.open).mockImplementation(async (target, flags, mode) => {
      const handle = await actualFs.open(target, flags, mode)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementation(async () =>
        Object.assign(await stat(), { uid: (uid ?? 0) + 1 }),
      )
      return handle
    })
    await expect(readIdentityFile(dir, uid, 'host.json')).rejects.toThrow(UNSAFE)
  })

  it('passes a missing file through as raw ENOENT', async () => {
    const error = await readIdentityFile(dir, uid, 'host.json').catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(IdentityFailure)
    expect(isMissing(error)).toBe(true)
  })
})

describe('identity directory checks', () => {
  it('counts only an Error carrying ENOENT as missing', () => {
    expect(isMissing(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissing({ code: 'ENOENT' })).toBe(false)
    expect(isMissing(denied())).toBe(false)
  })

  it('returns the lstat of an owner-private directory and refuses anything looser', async () => {
    expect((await checkIdentityDirectory(dir, uid)).ino).toBe((await actualFs.lstat(dir)).ino)
    expect((await existingIdentityDirectory(dir, uid))?.ino).toBe((await actualFs.lstat(dir)).ino)
    await expect(checkIdentityDirectory(dir, undefined)).rejects.toThrow(UNSAFE)
    await chmod(dir, 0o750)
    await expect(checkIdentityDirectory(dir, uid)).rejects.toThrow(UNSAFE)
    await expect(existingIdentityDirectory(dir, uid)).rejects.toThrow(UNSAFE)
  })

  it('reports a missing directory as null and any other lstat error as unsafe', async () => {
    expect(await existingIdentityDirectory(join(root, 'absent'), uid)).toBeNull()
    vi.mocked(filesystem.lstat).mockRejectedValueOnce(denied())
    await expect(existingIdentityDirectory(dir, uid)).rejects.toThrow(UNSAFE)
  })

  it('creates a missing directory owner-only and passes mkdir errors through raw', async () => {
    const created = join(root, 'nested', 'identity')
    await ensureIdentityDirectory(created, uid)
    expect((await actualFs.lstat(created)).mode & 0o777).toBe(0o700)
    await writeFile(join(root, 'file'), '')
    await expect(ensureIdentityDirectory(join(root, 'file', 'identity'), uid)).rejects.toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    )
    await chmod(created, 0o750)
    await expect(ensureIdentityDirectory(created, uid)).rejects.toThrow(UNSAFE)
  })

  it('probes an entry by lstat, so a dangling symlink exists', async () => {
    await symlink(join(root, 'absent'), join(dir, 'dangling'))
    expect(await identityEntryExists(join(dir, 'dangling'))).toBe(true)
    expect(await identityEntryExists(join(dir, 'absent'))).toBe(false)
    const error = denied()
    vi.mocked(filesystem.lstat).mockRejectedValueOnce(error)
    await expect(identityEntryExists(join(dir, 'host.json'))).rejects.toBe(error)
  })

  it('removes a file, ignores a missing one and refuses one it cannot unlink', async () => {
    await writeFile(join(dir, 'pending.json'), '', { mode: 0o600 })
    await removeIdentityFile(dir, 'pending.json')
    await removeIdentityFile(dir, 'pending.json')
    expect(await readdir(dir)).toEqual([])
    await mkdir(join(dir, 'pending.json'))
    await expect(removeIdentityFile(dir, 'pending.json')).rejects.toThrow(UNSAFE)
  })
})

describe('identity atomic publication', () => {
  it('writes, syncs and closes an owner-only temp file before renaming it, then removes it', async () => {
    await writeFile(join(dir, 'host.json'), 'old', { mode: 0o600 })
    traceHandles()
    await writeIdentityFileAtomic(location(), 'host.json', 'new\n')
    expect(events).toEqual([
      'open TMP wx 384',
      'writeFile',
      'sync',
      'close',
      'rename TMP host.json',
      'unlink TMP',
    ])
    expect(await readFile(join(dir, 'host.json'), 'utf8')).toBe('new\n')
    expect((await actualFs.lstat(join(dir, 'host.json'))).mode & 0o777).toBe(0o600)
    expect(await temps()).toEqual([])
  })

  it.each(['writeFile', 'sync'] as const)(
    'closes and removes the temp file when %s fails, without renaming',
    async (fail) => {
      traceHandles(fail)
      await expect(writeIdentityFileAtomic(location(), 'host.json', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      })
      expect(events.slice(-2)).toEqual(['close', 'unlink TMP'])
      expect(events.some((event) => event.startsWith('rename'))).toBe(false)
      expect(await readdir(dir)).toEqual([])
    },
  )

  it('checks the signal only once the temp file is closed, before the rename', async () => {
    const abort = new AbortController()
    traceHandles()
    const traced = vi.mocked(filesystem.open).getMockImplementation()
    vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
      abort.abort()
      if (!traced) throw new Error('traceHandles installs open')
      return traced(path, flags, mode)
    })
    const writing = writeIdentityFileAtomic(location(), 'host.json', 'x', abort.signal)
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.slice(-3)).toEqual(['sync', 'close', 'unlink TMP'])
    expect(await readdir(dir)).toEqual([])
  })

  it('passes a rename failure through raw and keeps the earlier file', async () => {
    await writeFile(join(dir, 'host.json'), 'old', { mode: 0o600 })
    const failure = new Error('rename failed')
    const broken = location(async () => Promise.reject(failure))
    await expect(writeIdentityFileAtomic(broken, 'host.json', 'new')).rejects.toBe(failure)
    expect(await readFile(join(dir, 'host.json'), 'utf8')).toBe('old')
    expect(await temps()).toEqual([])
  })

  it('reports unsafe when the temp file cannot be removed, even after a rename', async () => {
    vi.mocked(filesystem.unlink).mockRejectedValue(denied())
    await expect(writeIdentityFileAtomic(location(), 'host.json', 'new')).rejects.toThrow(UNSAFE)
    expect(await readFile(join(dir, 'host.json'), 'utf8')).toBe('new')
  })
})

describe('identity key cleanup', () => {
  it('removes host-key.<uuid>.pem files except the one kept', async () => {
    const files = [
      `host-key.${hostId}.pem`,
      `host-key.${otherId}.pem`,
      'host-key.not-a-uuid.pem',
      'pending-key.pem',
      'host.json',
    ]
    for (const file of files) await writeFile(join(dir, file), '', { mode: 0o600 })
    await cleanHostKeys(dir, `host-key.${hostId}.pem`)
    expect((await readdir(dir)).sort()).toEqual(
      [`host-key.${hostId}.pem`, 'host-key.not-a-uuid.pem', 'host.json', 'pending-key.pem'].sort(),
    )
    await cleanHostKeys(dir)
    expect((await readdir(dir)).sort()).toEqual(
      ['host-key.not-a-uuid.pem', 'host.json', 'pending-key.pem'].sort(),
    )
  })

  it('scans 1000 entries and refuses the 1001st', async () => {
    for (let index = 0; index < 1000; index++) await writeFile(join(dir, `unused-${index}`), '')
    await expect(cleanHostKeys(dir)).resolves.toBeUndefined()
    await writeFile(join(dir, 'unused-past-limit'), '')
    await expect(cleanHostKeys(dir)).rejects.toThrow(
      'Too many identity files. Remove unused host-key files.',
    )
  })

  it('passes a key unlink failure through raw', async () => {
    await writeFile(join(dir, `host-key.${hostId}.pem`), '', { mode: 0o600 })
    const error = denied()
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(error)
    await expect(cleanHostKeys(dir)).rejects.toBe(error)
  })
})
