import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transferEntry } from './file-transfer'

let root: string, ws: string, source: string, dir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pidex-transfer-'))
  ws = join(root, 'workspace')
  source = join(root, 'report.pdf')
  dir = join(ws, 'docs')
  await mkdir(dir, { recursive: true })
  await writeFile(source, Buffer.from([0, 255, 1, 2]))
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('imports binary bytes, duplicates in place, and moves within the workspace', async () => {
  const copied = await transferEntry(ws, source, ws, 'copy')
  expect(await readFile(copied)).toEqual(await readFile(source))
  expect(await transferEntry(ws, copied, ws, 'copy')).toBe(join(ws, 'report copy.pdf'))
  expect(await transferEntry(ws, copied, ws, 'copy')).toBe(join(ws, 'report copy 2.pdf'))
  const moved = await transferEntry(ws, copied, dir, 'move')
  expect(await readFile(moved)).toEqual(await readFile(source))
  await expect(readFile(copied)).rejects.toThrow()
})

it('refuses overwrite, outside moves, workspace-root moves and directory recursion', async () => {
  await transferEntry(ws, source, ws, 'copy')
  await expect(transferEntry(ws, source, ws, 'copy')).rejects.toThrow('Already exists')
  await expect(transferEntry(ws, source, dir, 'move')).rejects.toThrow('inside this workspace')
  await expect(transferEntry(ws, ws, dir, 'move')).rejects.toThrow()
  await expect(transferEntry(ws, dir, dir, 'copy')).rejects.toThrow('inside itself')
  await expect(transferEntry(ws, source, root, 'copy')).rejects.toThrow('Destination')
  expect(await readFile(source)).toEqual(Buffer.from([0, 255, 1, 2]))
})

it.skipIf(process.platform === 'win32')(
  'copies nested folders without following links and refuses destination symlink escape',
  async () => {
    const folder = join(root, 'import')
    await mkdir(join(folder, 'nested'), { recursive: true })
    await writeFile(join(folder, 'nested', 'a.txt'), 'nested')
    await symlink(source, join(folder, 'link'))
    const copied = await transferEntry(ws, folder, ws, 'copy')
    expect(await readFile(join(copied, 'nested/a.txt'), 'utf8')).toBe('nested')
    expect(await readlink(join(copied, 'link'))).toBe(source)
    await symlink(root, join(ws, 'escape'))
    await expect(transferEntry(ws, source, join(ws, 'escape'), 'copy')).rejects.toThrow(
      'Destination',
    )
  },
)
