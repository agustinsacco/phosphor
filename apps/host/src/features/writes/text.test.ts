import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeText } from './text'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

let root: string
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'writes-text-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it('stages exclusively, syncs and closes before publishing an existing file by rename', async () => {
  const target = join(root, 'a')
  await fs.writeFile(target, 'old', { mode: 0o640 })
  const events: string[] = []
  const originalOpen = fs.open
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).includes('.phosphor-write-')) {
      const sync = handle.sync.bind(handle)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push('sync')
        await sync()
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        events.push('close')
        await close()
      })
    }
    return handle
  })
  const rename = fs.rename
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    events.push('rename')
    expect(await fs.readFile(target, 'utf8')).toBe('old')
    return rename(...args)
  })
  const link = vi.spyOn(fs, 'link')
  const result = await writeText(root, {
    type: 'files.write',
    path: 'a',
    content: 'new',
    expected: hash('old'),
  })
  expect(result).toEqual({ revision: hash('new'), mtimeMs: (await fs.lstat(target)).mtimeMs })
  expect(open).toHaveBeenCalledWith(expect.stringContaining('.phosphor-write-'), 'wx', 0o640)
  expect(events).toEqual(['sync', 'close', 'rename'])
  expect(link).not.toHaveBeenCalled()
  expect(await fs.readFile(target, 'utf8')).toBe('new')
  expect(await fs.readdir(root)).toEqual(['a'])
})

it('publishes new files with link rather than replacement and removes staging bytes', async () => {
  const link = vi.spyOn(fs, 'link')
  const rename = vi.spyOn(fs, 'rename')
  const open = vi.spyOn(fs, 'open')
  expect(
    await writeText(root, {
      type: 'files.write',
      path: 'a',
      content: 'created',
      expected: null,
    }),
  ).toMatchObject({ revision: hash('created') })
  expect(open).toHaveBeenCalledWith(expect.stringContaining('.phosphor-write-'), 'wx', 0o600)
  expect(link).toHaveBeenCalledOnce()
  expect(rename).not.toHaveBeenCalled()
  expect(await fs.readdir(root)).toEqual(['a'])
})

it('rehashes staged writes and leaves racing target bytes untouched', async () => {
  const target = join(root, 'a')
  await fs.writeFile(target, 'old')
  const original = fs.open
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).includes('.phosphor-write-')) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        await fs.writeFile(target, 'racer')
      })
    }
    return handle
  })
  const rename = vi.spyOn(fs, 'rename')
  await expect(
    writeText(root, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: hash('old'),
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(rename).not.toHaveBeenCalled()
  expect(await fs.readFile(target, 'utf8')).toBe('racer')
  expect(await fs.readdir(root)).toEqual(['a'])
})

it.each(['writeFile', 'sync'] as const)('cleans staging on %s failure', async (method) => {
  const target = join(root, 'a')
  await fs.writeFile(target, 'old')
  const original = fs.open
  const error = new Error('Disk unavailable')
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).includes('.phosphor-write-'))
      vi.spyOn(handle, method).mockRejectedValueOnce(error)
    return handle
  })
  await expect(
    writeText(root, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: hash('old'),
    }),
  ).rejects.toBe(error)
  expect(await fs.readFile(target, 'utf8')).toBe('old')
  expect(await fs.readdir(root)).toEqual(['a'])
})

it('cleans staging if the final no-replace link loses a creation race', async () => {
  const original = fs.link
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await fs.writeFile(to, 'racer', { flag: 'wx' })
    return original(from, to)
  })
  await expect(
    writeText(root, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: null,
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(join(root, 'a'), 'utf8')).toBe('racer')
  expect(await fs.readdir(root)).toEqual(['a'])
})
