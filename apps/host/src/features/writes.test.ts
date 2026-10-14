import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { FeatureContext } from './feature'
import { createWrites, mutationPath } from './writes'
import { openStore, type HostStore } from '../lanes/store'
import { createFilesFeature } from './files'

// Copy the real namespace so Vitest can spy on configurable exports in ESM.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

let base: string, root: string, laneId: string, context: FeatureContext, store: HostStore
let writes: ReturnType<typeof createWrites>
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'writes-'))
  root = join(base, 'repo')
  await mkdir(root)
  store = await openStore(join(base, 'state'), process.getuid?.())
  const repository = store.syncRepositories([root])[0]
  if (!repository) throw new Error('Missing repository')
  laneId = store.ensureLane({ repositoryId: repository.id, cwd: root, sessionFile: null }).laneId
  context = { store, env: { XDG_DATA_HOME: join(base, 'data') }, home: base, log: vi.fn() }
  writes = createWrites(context)
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(base, { recursive: true, force: true })
})
it('reads exact revisions and writes only matching bytes; null exclusively creates', async () => {
  await writeFile(join(root, 'a'), 'old')
  expect(await createFilesFeature(context).call('files.read', { laneId, path: 'a' })).toMatchObject(
    { data: { revision: hash('old') } },
  )
  expect(
    await createFilesFeature(context).call('files.read', { laneId, path: 'missing' }),
  ).toMatchObject({ data: { revision: null } })
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'a',
      content: 'new',
      expected: null,
    }),
  ).toEqual({ ok: false, code: 'conflict' })
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'a',
      content: 'new',
      expected: hash('old'),
    }),
  ).toMatchObject({ ok: true, data: { revision: hash('new') } })
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('new')
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: hash('old'),
    }),
  ).toEqual({ ok: false, code: 'conflict' })
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'b',
      content: 'created',
      expected: null,
    }),
  ).toMatchObject({ ok: true })
  expect((await readdir(root)).sort()).toEqual(['a', 'b'])
})
it('rechecks revisions after staging and cleans temp files on a conflict', async () => {
  await writeFile(join(root, 'a'), 'old')
  const rename = vi.spyOn(fs, 'rename')
  const original = fs.lstat
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (
      String(args[0]).endsWith('/a') &&
      (await readdir(root)).some((v) => v.startsWith('.phosphor-write-'))
    )
      await writeFile(join(root, 'a'), 'raced')
    return original(...args)
  })
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: hash('old'),
    }),
  ).toEqual({ ok: false, code: 'conflict' })
  expect(rename).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual(['a'])
})
it('atomic no-replace handles a racing create and cleans temp files', async () => {
  const original = fs.link
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await writeFile(to, 'racer', { flag: 'wx' })
    return original(from, to)
  })
  expect(
    await writes.execute(laneId, {
      type: 'files.write',
      path: 'a',
      content: 'bad',
      expected: null,
    }),
  ).toEqual({ ok: false, code: 'conflict' })
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('racer')
  expect(await readdir(root)).toEqual(['a'])
})
it('rejects symlink parents and leaves outsiders unchanged; refuses unknown lanes and metadata', async () => {
  await writeFile(join(base, 'outside'), 'safe')
  await symlink(base, join(root, 'alias'))
  await symlink(join(base, 'outside'), join(root, 'file'))
  for (const path of ['alias/outside', 'file', '.git/config', '../outside'])
    expect(
      (
        await writes.execute(laneId, {
          type: 'files.write',
          path,
          content: 'bad',
          expected: hash('safe'),
        })
      ).ok,
    ).toBe(false)
  expect(await readFile(join(base, 'outside'), 'utf8')).toBe('safe')
  expect(
    (await writes.execute(randomUUID(), { type: 'files.create', path: 'a', kind: 'file' })).ok,
  ).toBe(false)
})
it('creates exclusively, renames without replacing, and transfers with copy naming', async () => {
  expect(
    await writes.execute(laneId, { type: 'files.create', path: 'dir', kind: 'directory' }),
  ).toEqual({ ok: true })
  expect(
    await writes.execute(laneId, { type: 'files.create', path: 'dir', kind: 'directory' }),
  ).toEqual({ ok: false, code: 'conflict' })
  expect(await writes.execute(laneId, { type: 'files.create', path: 'a', kind: 'file' })).toEqual({
    ok: true,
  })
  expect(await writes.execute(laneId, { type: 'files.create', path: 'a', kind: 'file' })).toEqual({
    ok: false,
    code: 'conflict',
  })
  await writeFile(join(root, 'a'), 'bytes')
  expect(
    await writes.execute(laneId, {
      type: 'files.transfer',
      source: 'a',
      directory: '.',
      mode: 'copy',
    }),
  ).toEqual({ ok: true, data: { path: 'a copy' } })
  expect(await writes.execute(laneId, { type: 'files.rename', from: 'a', to: 'a copy' })).toEqual({
    ok: false,
    code: 'conflict',
  })
  expect(
    await writes.execute(laneId, {
      type: 'files.transfer',
      source: 'a',
      directory: 'dir',
      mode: 'move',
    }),
  ).toEqual({ ok: true, data: { path: 'dir/a' } })
  expect(await readFile(join(root, 'a copy'), 'utf8')).toBe('bytes')
})
it('trashes bytes with metadata on Linux and never copy-deletes on EXDEV', async () => {
  await writeFile(join(root, 'a'), 'bytes')
  expect(await writes.execute(laneId, { type: 'files.delete', path: 'a' })).toEqual({ ok: true })
  const files =
    process.platform === 'darwin' ? join(base, '.Trash') : join(base, 'data/Trash/files')
  const names = await readdir(files)
  expect(names).toHaveLength(1)
  expect(await readFile(join(files, names[0] ?? ''), 'utf8')).toBe('bytes')
  if (process.platform !== 'darwin')
    expect(await readdir(join(base, 'data/Trash/info'))).toHaveLength(1)
  await writeFile(join(root, 'a'), 'keep')
  vi.spyOn(fs, 'link').mockRejectedValueOnce(
    Object.assign(new Error('Cross device'), { code: 'EXDEV' }),
  )
  expect((await writes.execute(laneId, { type: 'files.delete', path: 'a' })).ok).toBe(false)
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('keep')
})

it('rechecks parent identity and rejects a symlink swapped in after lstat', async () => {
  await mkdir(join(root, 'dir'))
  await mkdir(join(base, 'outside-dir'))
  const canonical = await fs.realpath(join(root, 'dir'))
  const original = fs.realpath
  let swapped = false
  vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (String(args[0]) === canonical && !swapped) {
      swapped = true
      await fs.rename(join(root, 'dir'), join(root, 'old-dir'))
      await symlink(join(base, 'outside-dir'), join(root, 'dir'))
    }
    return original(...args)
  })
  expect(
    await writes.execute(laneId, { type: 'files.create', path: 'dir/a', kind: 'file' }),
  ).toEqual({ ok: false, code: 'bad-request' })
  expect(await readdir(join(base, 'outside-dir'))).toEqual([])
})
it('cleans staged writes on fsync failure without touching the target', async () => {
  await writeFile(join(root, 'a'), 'old')
  const original = fs.open
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).includes('.phosphor-write-'))
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Disk unavailable'))
    return handle
  })
  expect(
    (
      await writes.execute(laneId, {
        type: 'files.write',
        path: 'a',
        content: 'bad',
        expected: hash('old'),
      })
    ).ok,
  ).toBe(false)
  expect(await readdir(root)).toEqual(['a'])
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('old')
})
it('never replaces a racing rename destination', async () => {
  await writeFile(join(root, 'a'), 'source')
  const original = fs.link
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await writeFile(to, 'racer', { flag: 'wx' })
    return original(from, to)
  })
  expect(await writes.execute(laneId, { type: 'files.rename', from: 'a', to: 'b' })).toEqual({
    ok: false,
    code: 'conflict',
  })
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('source')
  expect(await readFile(join(root, 'b'), 'utf8')).toBe('racer')
})
it('refuses symlinks and metadata encountered inside directory copies', async () => {
  await mkdir(join(root, 'source'))
  await mkdir(join(root, 'dest'))
  await writeFile(join(base, 'outside'), 'safe')
  await symlink(join(base, 'outside'), join(root, 'source', 'alias'))
  expect(
    (
      await writes.execute(laneId, {
        type: 'files.transfer',
        source: 'source',
        directory: 'dest',
        mode: 'copy',
      })
    ).ok,
  ).toBe(false)
  expect(await readFile(join(base, 'outside'), 'utf8')).toBe('safe')
  await rm(join(root, 'dest'), { recursive: true })
  await mkdir(join(root, 'dest'))
  await rm(join(root, 'source', 'alias'))
  await mkdir(join(root, 'source', '.git'))
  expect(
    (
      await writes.execute(laneId, {
        type: 'files.transfer',
        source: 'source',
        directory: 'dest',
        mode: 'copy',
      })
    ).ok,
  ).toBe(false)
})

it('rejects final symlinks at the mutation boundary even inside the lane', async () => {
  await writeFile(join(root, 'a'), 'safe')
  await symlink(join(root, 'a'), join(root, 'alias'))
  await expect(mutationPath(await fs.realpath(root), 'alias')).rejects.toThrow()
})

it('writes exclusive freedesktop trash metadata and removes it when a move fails', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  try {
    await writeFile(join(root, 'a'), 'bytes')
    expect(await writes.execute(laneId, { type: 'files.delete', path: 'a' })).toEqual({ ok: true })
    const info = join(base, 'data/Trash/info')
    const files = join(base, 'data/Trash/files')
    const names = await readdir(files)
    expect(names).toHaveLength(1)
    expect(await readdir(info)).toEqual([`${names[0]}.trashinfo`])
    const metadata = await readFile(join(info, `${names[0]}.trashinfo`), 'utf8')
    expect(metadata).toContain(`Path=${encodeURIComponent((await fs.realpath(root)) + '/a')}\n`)
    expect(metadata).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n/)
    await writeFile(join(root, 'b'), 'keep')
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('Cross device'), { code: 'EXDEV' }),
    )
    expect((await writes.execute(laneId, { type: 'files.delete', path: 'b' })).ok).toBe(false)
    expect(await readFile(join(root, 'b'), 'utf8')).toBe('keep')
    expect(await readdir(info)).toEqual([`${names[0]}.trashinfo`])
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.trashinfo'))
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Disk unavailable'))
      return handle
    })
    expect((await writes.execute(laneId, { type: 'files.delete', path: 'b' })).ok).toBe(false)
    expect(await readFile(join(root, 'b'), 'utf8')).toBe('keep')
    expect(await readdir(info)).toEqual([`${names[0]}.trashinfo`])
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each(['.Trash', 'Trash', 'Trash/files', 'Trash/info'])(
  'refuses a symlinked trash component %s without moving anything',
  async (component) => {
    vi.stubGlobal('process', { ...process, platform: component === '.Trash' ? 'darwin' : 'linux' })
    try {
      const path = component === '.Trash' ? join(base, component) : join(base, 'data', component)
      await mkdir(join(path, '..'), { recursive: true })
      const outside = join(base, 'outside-trash')
      await mkdir(outside)
      await symlink(outside, path)
      await writeFile(join(root, 'a'), 'keep')
      expect(await writes.execute(laneId, { type: 'files.delete', path: 'a' })).toEqual({
        ok: false,
        code: 'bad-request',
      })
      expect(await readFile(join(root, 'a'), 'utf8')).toBe('keep')
      expect(await readdir(outside)).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  },
)

it('records freedesktop DeletionDate in local time', async () => {
  const previous = process.env.TZ
  process.env.TZ = 'Pacific/Honolulu'
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-02-03T04:05:06Z'))
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  try {
    await writeFile(join(root, 'a'), 'bytes')
    expect(await writes.execute(laneId, { type: 'files.delete', path: 'a' })).toEqual({ ok: true })
    const info = join(base, 'data/Trash/info')
    const name = (await readdir(info))[0]
    if (!name) throw new Error('Missing metadata')
    expect(await readFile(join(info, name), 'utf8')).toContain('DeletionDate=2026-02-02T18:05:06\n')
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

it.each(['info', 'files'])(
  'rechecks the trash %s parent immediately before I/O',
  async (component) => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    try {
      const parent = join(await fs.realpath(base), 'data/Trash', component)
      const outside = join(base, 'outside-trash')
      await mkdir(outside)
      await writeFile(join(root, 'a'), 'keep')
      const original = fs.realpath
      let swapped = false
      vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
        if (String(args[0]) === parent && !swapped) {
          swapped = true
          await fs.rename(parent, parent + '-old')
          await symlink(outside, parent)
        }
        return original(...args)
      })
      expect(await writes.execute(laneId, { type: 'files.delete', path: 'a' })).toEqual({
        ok: false,
        code: 'bad-request',
      })
      expect(swapped).toBe(true)
      expect(await readFile(join(root, 'a'), 'utf8')).toBe('keep')
      expect(await readdir(outside)).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  },
)
