import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { walkFiles } from './walk'

let base: string
let root: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'walk-files-'))
  root = join(base, 'root')
  await mkdir(root)
})
afterEach(async () => {
  await chmod(join(root, 'locked'), 0o755).catch(() => {})
  await rm(base, { recursive: true, force: true })
})
async function put(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), '')
  }
}

describe('walkFiles', () => {
  it('skips ignored and hidden folders at any depth and keeps hidden files', async () => {
    await put(
      'a.txt',
      '.env',
      'src/b.ts',
      'src/node_modules/x.js',
      'pkg/dist/y.js',
      '.hidden/z.txt',
      'deep/.cache/w',
      'clone/.git/HEAD',
      'clone/c.ts',
    )
    const walked = await walkFiles(root, 100)
    expect(walked.files.sort()).toEqual(['.env', 'a.txt', 'clone/c.ts', 'src/b.ts'])
    expect(walked.truncated).toBe(false)
  })

  it("leaves out a worktree's .git file and any casing of .git", async () => {
    await put('.git', 'nested/.GIT', 'kept.txt')
    expect((await walkFiles(root, 100)).files).toEqual(['kept.txt'])
  })

  it('stops at the limit and says so, and an exact fit is not truncated', async () => {
    await put('a', 'b', 'c')
    expect(await walkFiles(root, 2)).toMatchObject({ truncated: true })
    expect((await walkFiles(root, 2)).files).toHaveLength(2)
    expect(await walkFiles(root, 3)).toMatchObject({ truncated: false })
  })

  it('never follows or lists a symlink', async () => {
    await put('kept.txt')
    await writeFile(join(base, 'outside'), '')
    await symlink(join(base, 'outside'), join(root, 'file-link'))
    await symlink(base, join(root, 'dir-link'))
    expect((await walkFiles(root, 100)).files).toEqual(['kept.txt'])
  })

  it.skipIf(process.getuid?.() === 0)('skips a folder it cannot read', async () => {
    await put('kept.txt', 'locked/x.txt')
    await chmod(join(root, 'locked'), 0)
    expect((await walkFiles(root, 100)).files).toEqual(['kept.txt'])
  })

  it('rejects with the reason once stopped', async () => {
    await put('a.txt')
    await expect(walkFiles(root, 100, AbortSignal.abort('time'))).rejects.toBe('time')
  })
})
