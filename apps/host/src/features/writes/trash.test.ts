import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FeatureContext } from '../feature'
import { trashEntry } from './trash'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

let base: string, root: string, context: FeatureContext
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'writes-trash-')))
  root = join(base, 'repo')
  await fs.mkdir(root)
  context = {
    store: { getLane: vi.fn(), listRepositories: () => [] },
    home: base,
    env: {},
    log: vi.fn(),
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(base, { recursive: true, force: true })
})

it.each([
  ['darwin', undefined, '.Trash'],
  ['linux', undefined, '.local/share/Trash/files'],
  ['linux', 'data', 'data/Trash/files'],
] as const)('uses platform %s trash with data home %s', async (platform, data, destination) => {
  vi.stubGlobal('process', { ...process, platform })
  if (data) context.env.XDG_DATA_HOME = join(base, data)
  await fs.writeFile(join(root, 'a b'), 'bytes')
  await trashEntry(context, root, 'a b')
  const files = join(base, destination)
  const names = await fs.readdir(files)
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/-a b$/)
  expect(await fs.readFile(join(files, names[0] ?? ''), 'utf8')).toBe('bytes')
  expect(await fs.readdir(root)).toEqual([])
  if (platform === 'linux') {
    const info = join(files, '../info', `${names[0]}.trashinfo`)
    expect(await fs.readFile(info, 'utf8')).toMatch(
      new RegExp(
        `^\\[Trash Info\\]\\nPath=${encodeURIComponent(join(root, 'a b'))}\\nDeletionDate=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\n$`,
      ),
    )
  }
})

it.each(['Trash', 'Trash/files', 'Trash/info'])(
  'rejects a symlinked %s ancestor without publishing bytes',
  async (component) => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    context.env.XDG_DATA_HOME = join(base, 'data')
    const path = join(base, 'data', component)
    await fs.mkdir(join(path, '..'), { recursive: true })
    const outside = join(base, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path)
    await fs.writeFile(join(root, 'a'), 'safe')
    await expect(trashEntry(context, root, 'a')).rejects.toMatchObject({ code: 'bad-request' })
    expect(await fs.readFile(join(root, 'a'), 'utf8')).toBe('safe')
    expect(await fs.readdir(outside)).toEqual([])
  },
)

it('refuses cross-device moves and rolls back only the new metadata', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  await fs.writeFile(join(root, 'a'), 'trashed')
  await trashEntry(context, root, 'a')
  const trash = join(base, '.local/share/Trash')
  const existing = await fs.readdir(join(trash, 'info'))
  await fs.writeFile(join(root, 'b'), 'safe')
  const error = Object.assign(new Error('Cross device'), { code: 'EXDEV' })
  vi.spyOn(fs, 'link').mockRejectedValueOnce(error)
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(trashEntry(context, root, 'b')).rejects.toBe(error)
  expect(copy).not.toHaveBeenCalled()
  expect(await fs.readFile(join(root, 'b'), 'utf8')).toBe('safe')
  expect(await fs.readdir(join(trash, 'info'))).toEqual(existing)
  expect(await fs.readdir(join(trash, 'files'))).toHaveLength(1)
})

it.each(['writeFile', 'sync'] as const)(
  'removes metadata on %s failure before moving',
  async (method) => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    await fs.writeFile(join(root, 'a'), 'safe')
    const original = fs.open
    const error = new Error('Metadata unavailable')
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]).endsWith('.trashinfo'))
        vi.spyOn(handle, method).mockRejectedValueOnce(error)
      return handle
    })
    const link = vi.spyOn(fs, 'link')
    await expect(trashEntry(context, root, 'a')).rejects.toBe(error)
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.trashinfo$/), 'wx', 0o600)
    expect(link).not.toHaveBeenCalled()
    expect(await fs.readFile(join(root, 'a'), 'utf8')).toBe('safe')
    expect(await fs.readdir(join(base, '.local/share/Trash/info'))).toEqual([])
  },
)
