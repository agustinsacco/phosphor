import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerTrash, type TrashRunner } from './delete-target'

let dir: string, file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owner-trash-'))
  file = join(dir, "test ' $ ;.jsonl")
  await writeFile(file, 'session')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it.each([
  [false, 'darwin'],
  [true, 'linux'],
] as const)('no system Trash override for local=%s platform=%s', (local, platform) => {
  const run = vi.fn<TrashRunner>()
  expect(ownerTrash(local, platform, run)).toBeUndefined()
  expect(run).not.toHaveBeenCalled()
})
it('passes the path only as argv and uses null Foundation out-pointers', async () => {
  const run = vi.fn<TrashRunner>(async (_bin, args) => {
    await rename(args.at(-1)!, join(dir, 'moved'))
  })
  await ownerTrash(true, 'darwin', run)!(file)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    expect.stringContaining('trashItemAtURLResultingItemURLError(url, null, null)'),
    file,
  ])
  expect(run.mock.calls[0]![1][3]).not.toContain(file)
  expect(await readFile(join(dir, 'moved'), 'utf8')).toBe('session')
})
it.each([false, true])(
  'after a runner error, checks whether source was moved (%s), never retries',
  async (moved) => {
    const run = vi.fn<TrashRunner>(async () => {
      if (moved) await rename(file, join(dir, 'moved'))
      throw Object.assign(new Error('runner failed'), { code: 'ENOENT' })
    })
    const move = ownerTrash(true, 'darwin', run)!(file)
    if (moved) await expect(move).resolves.toBeUndefined()
    else {
      await expect(move).rejects.toThrow('Trash')
      expect(await readFile(file, 'utf8')).toBe('session')
    }
    expect(run).toHaveBeenCalledOnce()
  },
)
