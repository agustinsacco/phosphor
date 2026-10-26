import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openStore, type HostStore } from '../lanes/store'
import { createRepositories, homeDirectory } from './repositories'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })
let home: string, configPath: string, store: HostStore
let service: ReturnType<typeof createRepositories>
let busy = false
const changed = vi.fn()
beforeEach(async () => {
  vi.mocked(fs.open).mockReset()
  home = await realpath(await mkdtemp(join(tmpdir(), 'host-folders-')))
  configPath = join(home, 'config.json')
  await mkdir(join(home, 'original'))
  await mkdir(join(home, 'Projects'))
  await mkdir(join(home, '.hidden'))
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: [join(home, 'original')],
      contextBudget: '400k',
    }),
    { mode: 0o600 },
  )
  store = await openStore(join(home, 'state'), process.getuid?.())
  store.syncRepositories([join(home, 'original')])
  busy = false
  changed.mockClear()
  service = createRepositories({
    home,
    configPath,
    uid: process.getuid?.(),
    store,
    live: () => busy,
    changed,
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(home, { recursive: true, force: true })
})
it('confines every canonical folder to home and refuses escaped symlinks', async () => {
  await symlink(tmpdir(), join(home, 'escape'))
  await expect(homeDirectory(home, 'escape')).rejects.toThrow()
  await expect(homeDirectory(home, '../')).rejects.toThrow()
  expect((await homeDirectory(home, 'Projects')).full).toBe(join(home, 'Projects'))
  const listed = await service.feature.call('machine.folders.list', {})
  expect(listed.ok).toBe(true)
  expect(JSON.stringify(listed)).not.toContain('.hidden')
  expect(JSON.stringify(listed)).not.toContain('escape')
  // Hidden folders only when asked: an older Desktop refuses a listing holding one.
  const hidden = await service.feature.call('machine.folders.list', { hidden: true })
  expect(JSON.stringify(hidden)).toContain('"name":".hidden"')
  expect(JSON.stringify(hidden)).not.toContain('escape')
  expect(await service.feature.call('machine.folders.list', { path: '.hidden' })).toMatchObject({
    ok: true,
    data: { path: '.hidden', entries: [] },
  })
})
it('creates one folder under an existing home folder, never escaping or overwriting', async () => {
  const create = (path: string, allowed = true) =>
    service.execute({ type: 'host.repositories.createFolder', path }, () => allowed)
  expect(await create('Projects/new-app')).toEqual({ ok: true })
  expect((await stat(join(home, 'Projects', 'new-app'))).isDirectory()).toBe(true)
  expect(await create('.hidden/.inner')).toEqual({ ok: true })
  expect(await create('top')).toEqual({ ok: true })
  expect(await create('Projects/new-app')).toEqual({ ok: false, code: 'conflict' })
  await writeFile(join(home, 'Projects', 'file'), '')
  expect(await create('Projects/file')).toEqual({ ok: false, code: 'conflict' })
  expect(await create('missing/child')).toEqual({ ok: false, code: 'bad-request' })
  await symlink(tmpdir(), join(home, 'escape'))
  expect(await create('escape/inside-tmp')).toEqual({ ok: false, code: 'bad-request' })
  expect(await create('Projects/refused', false)).toEqual({ ok: false, code: 'forbidden' })
  await expect(stat(join(home, 'Projects', 'refused'))).rejects.toThrow()
  // Creating is not adding: the config and the repository list are untouched.
  expect(JSON.parse(await readFile(configPath, 'utf8')).repositories).toEqual([
    join(home, 'original'),
  ])
  expect(changed).not.toHaveBeenCalled()
})
it('writes config atomically, preserves other fields, and only then updates roots and snapshots', async () => {
  const added = await service.execute(
    { type: 'host.repositories.add', path: 'Projects' },
    () => true,
  )
  expect(added.ok).toBe(true)
  expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
    contextBudget: '400k',
    repositories: [join(home, 'original'), join(home, 'Projects')],
  })
  expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(
    await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => true),
  ).toEqual({ ok: false, code: 'conflict' })
})
it('never updates the store or config after an atomic rename fails', async () => {
  const before = await readFile(configPath, 'utf8')
  vi.mocked(fsSync.renameSync).mockImplementationOnce(() => {
    throw new Error('disk refused')
  })
  expect(
    (await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => true)).ok,
  ).toBe(false)
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(store.listRepositories()).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
})
it('refuses capability loss, disabled changes and live repositories', async () => {
  const id = store.listRepositories()[0]?.id
  if (!id) throw new Error('fixture')
  busy = true
  expect(
    await service.execute({ type: 'host.repositories.remove', repositoryId: id }, () => true),
  ).toEqual({ ok: false, code: 'busy' })
  expect(
    await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => false),
  ).toEqual({ ok: false, code: 'forbidden' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.allowRepositoryChanges = false
  await writeFile(configPath, JSON.stringify(config))
  expect(await service.feature.call('machine.folders.list', {})).toMatchObject({
    ok: false,
    error: { code: 'forbidden' },
  })
  expect(
    await service.execute({ type: 'host.repositories.createFolder', path: 'new' }, () => true),
  ).toEqual({ ok: false, code: 'forbidden' })
  await expect(stat(join(home, 'new'))).rejects.toThrow()
})

it('refuses a permission change during the atomic write before rename', async () => {
  const before = await readFile(configPath, 'utf8')
  let allowed = true
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    const sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      await sync()
      allowed = false
    })
    return handle
  })
  expect(
    await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => allowed),
  ).toEqual({ ok: false, code: 'forbidden' })
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
})

it('bounds folder listings and configured repository count', async () => {
  await Promise.all(Array.from({ length: 501 }, (_v, i) => mkdir(join(home, `folder-${i}`))))
  const result = await service.feature.call('machine.folders.list', {})
  expect(result).toMatchObject({ ok: true, data: { truncated: true } })
  if (
    !result.ok ||
    typeof result.data !== 'object' ||
    result.data === null ||
    !('entries' in result.data)
  )
    throw new Error('result')
  expect(result.data.entries).toHaveLength(500)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.repositories = Array(64).fill(join(home, 'original'))
  await writeFile(configPath, JSON.stringify(config))
  expect(
    await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => true),
  ).toEqual({ ok: false, code: 'too-many-requests' })
})

it.each(['symlink', 'directory'])(
  'refuses a %s swap during config preparation before committing or publishing',
  async (swap) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'outside-home-')))
    const before = await readFile(configPath, 'utf8')
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        await fs.rename(join(home, 'Projects'), join(home, 'moved'))
        if (swap === 'symlink') await symlink(outside, join(home, 'Projects'))
        else await mkdir(join(home, 'Projects'))
      })
      return handle
    })
    try {
      expect(
        (await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => true)).ok,
      ).toBe(false)
      expect(await readFile(configPath, 'utf8')).toBe(before)
      expect(store.listRepositories()).toHaveLength(1)
      expect(changed).not.toHaveBeenCalled()
      expect(() =>
        store.syncRepositories([join(home, 'Projects')], undefined, {
          home,
          expected: { path: join(home, 'Projects'), dev: 0, ino: 0 },
        }),
      ).toThrow()
      // Hand-configured roots outside home remain supported at startup.
      expect(store.syncRepositories([outside])[0]?.path).toBe(outside)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  },
)

it('removes the last folder and can add the first folder to the empty config', async () => {
  const id = store.listRepositories()[0]?.id
  if (!id) throw new Error('fixture')
  expect(
    await service.execute({ type: 'host.repositories.remove', repositoryId: id }, () => true),
  ).toEqual({ ok: true })
  expect(JSON.parse(await readFile(configPath, 'utf8')).repositories).toEqual([])
  expect(store.listRepositories()).toEqual([])
  expect(
    (await service.execute({ type: 'host.repositories.add', path: 'Projects' }, () => true)).ok,
  ).toBe(true)
  expect(store.listRepositories()).toHaveLength(1)
})
it('reorders the config and lists repositories in that order, keeping inactive entries in place', async () => {
  await mkdir(join(home, 'third'))
  await symlink(join(home, 'third'), join(home, 'third-link'))
  const missing = join(home, 'missing')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.repositories = [
    join(home, 'original'),
    missing,
    join(home, 'Projects'),
    join(home, 'third-link'),
  ]
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  store.syncRepositories(config.repositories)
  const [original, projects, third] = store.listRepositories().map((r) => r.id)
  expect(store.listRepositories().map((r) => r.name)).toEqual(['original', 'Projects', 'third'])
  const order = (repositoryIds: string[], allowed = true) =>
    service.execute({ type: 'host.repositories.order', repositoryIds }, () => allowed)
  expect(await order([third!, original!, projects!])).toEqual({ ok: true })
  expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
    contextBudget: '400k',
    // The missing folder keeps its slot; the symlink keeps the spelling the user wrote.
    repositories: [
      join(home, 'third-link'),
      missing,
      join(home, 'original'),
      join(home, 'Projects'),
    ],
  })
  expect(store.listRepositories().map((r) => r.name)).toEqual(['third', 'original', 'Projects'])
  expect(changed).toHaveBeenCalledTimes(1)
  // A stale list, a stranger or a missing repository is a conflict and writes nothing.
  for (const ids of [
    [original!, projects!],
    [original!, projects!, third!, 'aaaaaaaaaaaaaaaa'],
  ])
    expect(await order(ids)).toEqual({ ok: false, code: 'conflict' })
  expect(await order([original!, projects!, third!], false)).toEqual({
    ok: false,
    code: 'forbidden',
  })
  expect(store.listRepositories().map((r) => r.name)).toEqual(['third', 'original', 'Projects'])
  expect(changed).toHaveBeenCalledTimes(1)
})
it('lists repositories in config order, not the order they were first added', () => {
  const a = join(home, 'original')
  const b = join(home, 'Projects')
  store.syncRepositories([a, b])
  expect(store.listRepositories().map((r) => r.name)).toEqual(['original', 'Projects'])
  expect(store.syncRepositories([b, a]).map((r) => r.name)).toEqual(['Projects', 'original'])
  expect(store.listRepositories().map((r) => r.name)).toEqual(['Projects', 'original'])
})
