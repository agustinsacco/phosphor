import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDir, createFile, renamePath } from './fs-service'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

it('creates entries and refuses duplicate files, directories and rename collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-mutations-'))
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
