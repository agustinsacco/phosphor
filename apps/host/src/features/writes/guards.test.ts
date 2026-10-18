import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import { mutationPath, revision, WriteFailure } from './guards'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'writes-guards-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it('allows only a missing final component and validates the canonical parent', async () => {
  await fs.mkdir(join(root, 'dir'))
  expect(await mutationPath(root, 'dir/new', true)).toBe(join(root, 'dir/new'))
  await expect(mutationPath(root, 'dir/new')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(mutationPath(root, 'absent/new', true)).rejects.toMatchObject({ code: 'ENOENT' })
  await fs.writeFile(join(root, 'file'), 'bytes')
  await expect(mutationPath(root, 'file/new', true)).rejects.toBeInstanceOf(WriteFailure)
})

it.each(['../escape', '/absolute', '.git/config', 'a//b', 'a/../b'])(
  'refuses invalid mutation path %s',
  async (path) => {
    await expect(mutationPath(root, path, true)).rejects.toMatchObject({ code: 'bad-request' })
  },
)

it('refuses leaf symlinks, parent symlinks and a noncanonical root', async () => {
  await fs.mkdir(join(root, 'dir'))
  await fs.writeFile(join(root, 'dir/a'), 'bytes')
  await fs.symlink(join(root, 'dir'), join(root, 'alias'))
  await fs.symlink(join(root, 'dir/a'), join(root, 'leaf'))
  for (const path of ['alias/a', 'leaf'])
    await expect(mutationPath(root, path)).rejects.toMatchObject({ code: 'bad-request' })
  await expect(mutationPath(join(root, 'alias'), 'a')).rejects.toMatchObject({
    code: 'bad-request',
  })
})

it('hashes bounded bytes using a no-follow nonblocking descriptor and closes it', async () => {
  const target = join(root, 'a')
  const bytes = Buffer.alloc(FILE_LIMITS.textBytes, 'x')
  await fs.writeFile(target, bytes)
  const original = fs.open
  const close = vi.fn()
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    const originalClose = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      close()
      await originalClose()
    })
    return handle
  })
  expect(await revision(target)).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(open).toHaveBeenCalledWith(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  expect(close).toHaveBeenCalledOnce()
})

it('returns null only for ENOENT and refuses oversized or non-file targets', async () => {
  expect(await revision(join(root, 'missing'))).toBeNull()
  const target = join(root, 'large')
  await fs.writeFile(target, Buffer.alloc(FILE_LIMITS.textBytes + 1))
  await expect(revision(target)).rejects.toMatchObject({ code: 'bad-request' })
  await expect(revision(root)).rejects.toMatchObject({ code: 'bad-request' })
  await fs.symlink(target, join(root, 'alias'))
  await expect(revision(join(root, 'alias'))).rejects.toThrow()
  const error = { code: 123 }
  vi.spyOn(fs, 'open').mockRejectedValueOnce(error)
  await expect(revision(target)).rejects.toBe(error)
})

it('bounds bytes read even if a file grows after stat and closes on rejection', async () => {
  const target = join(root, 'a')
  await fs.writeFile(target, 'small')
  const original = fs.open
  const close = vi.fn()
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    const stat = handle.stat.bind(handle)
    vi.spyOn(handle, 'stat').mockImplementation(async () => {
      const info = await stat()
      await fs.writeFile(target, Buffer.alloc(FILE_LIMITS.textBytes + 1))
      return info
    })
    const originalClose = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      close()
      await originalClose()
    })
    return handle
  })
  await expect(revision(target)).rejects.toMatchObject({ code: 'bad-request' })
  expect(close).toHaveBeenCalledOnce()
})
