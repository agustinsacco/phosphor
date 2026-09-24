import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDir,
  createFile,
  listDir,
  readTextFile,
  renamePath,
  statDirectories,
} from './fs-service'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

it('lists and stats directories without opening multi-gigabyte files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-large-listing-'))
  roots.push(root)
  const videos = join(root, 'videos')
  const movie = join(root, 'movie.mp4')
  await mkdir(videos)
  await writeFile(movie, '')
  await truncate(movie, 5 * 1024 * 1024 * 1024)

  await expect(listDir(root, root, { respectGitignore: false })).resolves.toMatchObject([
    { name: 'videos', isDirectory: true },
    { name: 'movie.mp4', isDirectory: false },
  ])
  await expect(statDirectories([root, videos, movie])).resolves.toEqual([
    { path: root, mtimeMs: expect.any(Number) },
    { path: videos, mtimeMs: expect.any(Number) },
    { path: movie, mtimeMs: null },
  ])
})

it('hands media to its viewer without reading it, but still reads pages as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-read-media-'))
  roots.push(root)
  const movie = join(root, 'movie.mp4')
  const page = join(root, 'index.html')
  await writeFile(movie, '')
  await truncate(movie, 5 * 1024 * 1024 * 1024)
  await writeFile(page, '<h1>hi</h1>')

  // Past the 4 MB cap, so a read would have reported tooLarge instead.
  await expect(readTextFile(movie)).resolves.toMatchObject({
    binary: true,
    content: '',
    size: 5 * 1024 * 1024 * 1024,
  })
  expect((await readTextFile(movie)).tooLarge).toBeUndefined()
  // HTML keeps a source view, so it is read like any text file.
  await expect(readTextFile(page)).resolves.toMatchObject({ content: '<h1>hi</h1>' })
})

it('creates entries and refuses duplicate files, directories and rename collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-mutations-'))
  roots.push(root)
  const a = join(root, 'a'),
    b = join(root, 'b'),
    dir = join(root, 'dir')
  await createFile(a)
  await writeFile(a, 'keep')
  await createFile(b)
  await createDir(dir)
  await expect(createFile(a)).rejects.toThrow()
  await expect(createDir(dir)).rejects.toThrow()
  await expect(renamePath(b, a)).rejects.toThrow('Already exists')
  expect(await readFile(a, 'utf8')).toBe('keep')
  await renamePath(b, join(dir, 'b'))
  expect(await readFile(join(dir, 'b'), 'utf8')).toBe('')
  if (process.platform !== 'win32') {
    const link = join(root, 'link')
    await symlink(join(root, 'missing'), link)
    await expect(renamePath(a, link)).rejects.toThrow('Already exists')
  }
})
