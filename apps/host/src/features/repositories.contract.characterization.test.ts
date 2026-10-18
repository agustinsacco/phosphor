import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type HostStore } from '../lanes/store'
import { createRepositories } from './repositories'

vi.mock('node:fs/promises', { spy: true })
let home: string, configPath: string, store: HostStore
let service: ReturnType<typeof createRepositories>
const changed = vi.fn()
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'repository-contract-')))
  configPath = join(home, 'config.json')
  await mkdir(join(home, 'original'))
  await mkdir(join(home, 'new'))
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: [join(home, 'original')],
    }),
    { mode: 0o600 },
  )
  store = await openStore(join(home, 'state'), process.getuid?.())
  store.syncRepositories([join(home, 'original')])
  changed.mockClear()
  service = createRepositories({
    home,
    configPath,
    uid: process.getuid?.(),
    store,
    live: () => false,
    changed,
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(home, { recursive: true, force: true })
})

it('blocks browsing and every mutation when repository changes are disabled', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...config, allowRepositoryChanges: false }))
  expect(await service.feature.call('machine.folders.list', {})).toMatchObject({
    ok: false,
    error: { code: 'forbidden' },
  })
  const repositoryId = store.listRepositories()[0]!.id
  for (const op of [
    { type: 'host.repositories.add', path: 'new' },
    { type: 'host.repositories.createFolder', path: 'created' },
    { type: 'host.repositories.remove', repositoryId },
  ] as const) {
    expect(await service.execute(op, () => true)).toEqual({ ok: false, code: 'forbidden' })
  }
  expect(changed).not.toHaveBeenCalled()
})

it('rechecks the new folder identity after staging and before config publication', async () => {
  const before = await readFile(configPath, 'utf8')
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    const sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      await sync()
      await fs.rename(join(home, 'new'), join(home, 'moved'))
      await mkdir(join(home, 'new'))
    })
    return handle
  })
  expect(await service.execute({ type: 'host.repositories.add', path: 'new' }, () => true)).toEqual(
    { ok: false, code: 'bad-request' },
  )
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(store.listRepositories()).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
})

it('refuses a live repository and rechecks liveness before staging removal', async () => {
  const repositoryId = store.listRepositories()[0]!.id
  const live = vi.fn(() => true)
  service = createRepositories({
    home,
    configPath,
    uid: process.getuid?.(),
    store,
    live,
    changed,
  })
  const op = { type: 'host.repositories.remove', repositoryId } as const
  expect(await service.execute(op, () => true)).toEqual({ ok: false, code: 'busy' })
  live.mockReturnValueOnce(false).mockReturnValueOnce(true)
  expect(await service.execute(op, () => true)).toEqual({ ok: false, code: 'busy' })
  expect(store.listRepositories()).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
})

it('preserves busy on removal authority loss before staging and forbidden after staging', async () => {
  const repositoryId = store.listRepositories()[0]!.id
  const op = { type: 'host.repositories.remove', repositoryId } as const
  const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
  expect(await service.execute(op, allowed)).toEqual({ ok: false, code: 'busy' })
  const duringSave = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false)
  expect(await service.execute(op, duringSave)).toEqual({ ok: false, code: 'forbidden' })
  expect(store.listRepositories()).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
})

async function listing(kind: 'directory' | 'file', count: number) {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  const entries = await actual.readdir(home, { withFileTypes: true })
  const sample = entries.find((entry) =>
    kind === 'directory' ? entry.isDirectory() : entry.isFile(),
  )!
  const visited = vi.fn()
  vi.spyOn(fs, 'opendir').mockImplementation(async (path) => {
    const directory = await actual.opendir(path)
    directory[Symbol.asyncIterator] = async function* () {
      try {
        for (let i = 0; i < count; i++) {
          visited()
          yield sample
        }
      } finally {
        await directory.close()
      }
      return undefined
    }
    return directory
  })
  return visited
}

it('caps emitted folders at 500 and sorts the emitted listing', async () => {
  const normal = await service.feature.call('machine.folders.list', {})
  expect(normal).toMatchObject({ ok: true, data: { truncated: false } })
  expect(JSON.stringify(normal)).toMatch(/"name":"new".*"name":"original".*"name":"state"/)
  const visited = await listing('directory', 502)
  const result = await service.feature.call('machine.folders.list', {})
  expect(result).toMatchObject({ ok: true, data: { truncated: true } })
  expect(JSON.stringify(result).match(/"name":/g)).toHaveLength(500)
  expect(visited).toHaveBeenCalledTimes(501)
})

it('caps scanned entries at 20000 even when no folders are emitted', async () => {
  const visited = await listing('file', 20002)
  expect(await service.feature.call('machine.folders.list', {})).toMatchObject({
    ok: true,
    data: { entries: [], truncated: true },
  })
  expect(visited).toHaveBeenCalledTimes(20001)
})
