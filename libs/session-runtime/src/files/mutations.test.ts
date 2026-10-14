import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, lstat } from 'node:fs/promises'
import type * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { transferEntry } from './mutations'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

it('never merges a directory created after the absence check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copy-race-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    const target = join(dest, 'source')
    await mkdir(source)
    await mkdir(dest)
    await writeFile(join(source, 'child'), 'source')
    // The guard runs after requireMissing, immediately before the copy.
    await expect(
      transferEntry(root, source, dest, 'copy', async (path) => {
        if (path === target) {
          await mkdir(target)
          await writeFile(join(target, 'racer'), 'keep')
        }
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readdir(target)).toEqual(['racer'])
    expect(await readFile(join(target, 'racer'), 'utf8')).toBe('keep')
    expect(await readFile(join(source, 'child'), 'utf8')).toBe('source')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('copies children before preserving a read-only source directory mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copy-mode-'))
  const source = join(root, 'source')
  const dest = join(root, 'dest')
  try {
    await mkdir(source)
    await mkdir(dest)
    await writeFile(join(source, 'child'), 'bytes')
    await chmod(source, 0o555)
    const target = await transferEntry(root, source, dest, 'copy')
    expect(await readFile(join(target, 'child'), 'utf8')).toBe('bytes')
    expect((await lstat(target)).mode & 0o777).toBe((await lstat(source)).mode & 0o777)
  } finally {
    await chmod(source, 0o755)
    await chmod(join(dest, 'source'), 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
