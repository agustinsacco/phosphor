import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as mutations from '@phosphor/session-runtime/files/mutations'
import { createEntry, renameEntry, transferEntry } from './entries'

vi.mock('@phosphor/session-runtime/files/mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof mutations>()),
}))

let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'writes-entries-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it.each(['file', 'directory'] as const)('creates a %s exclusively', async (kind) => {
  await createEntry(root, { type: 'files.create', path: 'a', kind })
  expect((await fs.lstat(join(root, 'a'))).isDirectory()).toBe(kind === 'directory')
  await expect(createEntry(root, { type: 'files.create', path: 'a', kind })).rejects.toMatchObject({
    code: 'EEXIST',
  })
})

it('delegates guarded renames to the existing no-replace helper', async () => {
  await fs.writeFile(join(root, 'a'), 'source')
  const rename = vi.spyOn(mutations, 'renameNoReplace')
  await renameEntry(root, { type: 'files.rename', from: 'a', to: 'b' })
  expect(rename).toHaveBeenCalledExactlyOnceWith(join(root, 'a'), join(root, 'b'))
  await fs.writeFile(join(root, 'a'), 'racer')
  await expect(
    renameEntry(root, { type: 'files.rename', from: 'b', to: 'a' }),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(join(root, 'b'), 'utf8')).toBe('source')
  expect(await fs.readFile(join(root, 'a'), 'utf8')).toBe('racer')
})

it('refuses renames into their own subtree before delegating', async () => {
  await fs.mkdir(join(root, 'dir'))
  const rename = vi.spyOn(mutations, 'renameNoReplace')
  await expect(
    renameEntry(root, { type: 'files.rename', from: 'dir', to: 'dir/child' }),
  ).rejects.toMatchObject({ code: 'bad-request' })
  expect(rename).not.toHaveBeenCalled()
})

it('preserves copy naming, move destinations and relative result paths', async () => {
  await fs.mkdir(join(root, 'dest'))
  await fs.writeFile(join(root, 'a.txt'), 'source')
  expect(
    await transferEntry(root, {
      type: 'files.transfer',
      source: 'a.txt',
      directory: '.',
      mode: 'copy',
    }),
  ).toEqual({ path: 'a copy.txt' })
  expect(
    await transferEntry(root, {
      type: 'files.transfer',
      source: 'a.txt',
      directory: 'dest',
      mode: 'move',
    }),
  ).toEqual({ path: 'dest/a.txt' })
  expect(await fs.readFile(join(root, 'a copy.txt'), 'utf8')).toBe('source')
  expect(await fs.readFile(join(root, 'dest/a.txt'), 'utf8')).toBe('source')
})

it.each(['outside', 'metadata', 'symlink'] as const)(
  'fences %s paths requested by the transfer helper',
  async (kind) => {
    await fs.writeFile(join(root, 'a'), 'source')
    await fs.symlink(join(root, 'a'), join(root, 'alias'))
    const path =
      kind === 'outside'
        ? join(root, '..', 'outside')
        : join(root, kind === 'metadata' ? '.git/config' : 'alias')
    vi.spyOn(mutations, 'transferEntry').mockImplementation(
      async (_root, source, directory, mode, guard) => {
        expect([_root, source, directory, mode]).toEqual([root, join(root, 'a'), root, 'copy'])
        if (!guard) throw new Error('Missing guard')
        await guard(path, true)
        throw new Error('Guard did not reject path')
      },
    )
    await expect(
      transferEntry(root, {
        type: 'files.transfer',
        source: 'a',
        directory: '.',
        mode: 'copy',
      }),
    ).rejects.toMatchObject({ code: 'bad-request' })
    expect(await fs.readFile(join(root, 'a'), 'utf8')).toBe('source')
  },
)

it('allows a missing destination leaf but not missing transfer ancestors', async () => {
  await fs.writeFile(join(root, 'a'), 'source')
  vi.spyOn(mutations, 'transferEntry').mockImplementation(
    async (_root, _source, _directory, _mode, guard) => {
      if (!guard) throw new Error('Missing guard')
      await guard(join(root, 'new'), true)
      await guard(join(root, 'absent/new'), true)
      throw new Error('Guard did not reject missing ancestor')
    },
  )
  await expect(
    transferEntry(root, {
      type: 'files.transfer',
      source: 'a',
      directory: '.',
      mode: 'copy',
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})
