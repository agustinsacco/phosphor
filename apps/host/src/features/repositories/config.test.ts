import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as stores from '../../lanes/store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  loadRepositoryConfig,
  publishRepositoryConfig,
  type RepositoryConfigOptions,
} from './config'

vi.mock('node:fs/promises', { spy: true })
vi.mock('node:fs', { spy: true })
vi.mock('../../lanes/store', { spy: true })
let home: string, configPath: string, store: stores.HostStore
let options: RepositoryConfigOptions
const changed = vi.fn()
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'repository-config-')))
  configPath = join(home, 'config.json')
  await fs.mkdir(join(home, 'original'))
  await fs.mkdir(join(home, 'new'))
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: [join(home, 'original')],
      contextBudget: '400k',
    }),
    { mode: 0o600 },
  )
  const actualStores = await vi.importActual<typeof stores>('../../lanes/store')
  store = await actualStores.openStore(join(home, 'state'), process.getuid?.())
  store.syncRepositories([join(home, 'original')])
  changed.mockReset()
  options = { configPath, uid: process.getuid?.(), store, changed }
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await fs.rm(home, { recursive: true, force: true })
})

async function noStagingFiles() {
  expect((await fs.readdir(home)).filter((name) => name.startsWith('.config-'))).toEqual([])
}

it('stages exclusively with mode 0600, fsyncs and closes before atomic publication', async () => {
  const events: string[] = []
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    expect(args).toEqual([expect.stringMatching(/\.config-.*\.tmp$/), 'wx', 0o600])
    const handle = await actual.open(...args)
    const write = handle.writeFile.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementation(async (...params) => {
      events.push('writeFile')
      await write(...params)
    })
    const sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      events.push('sync')
      await sync()
    })
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      events.push('close')
      await close()
    })
    return handle
  })
  const actualStore = store.syncRepositories.bind(store)
  vi.spyOn(store, 'syncRepositories').mockImplementation((...args) => {
    events.push('store')
    return actualStore(...args)
  })
  const actualStores = await vi.importActual<typeof stores>('../../lanes/store')
  vi.spyOn(stores, 'validateRepositoryIdentity').mockImplementation((identity) => {
    events.push('identity')
    actualStores.validateRepositoryIdentity(identity)
    queueMicrotask(() => events.push('microtask'))
  })
  const actualSync = await vi.importActual<typeof fsSync>('node:fs')
  vi.spyOn(fsSync, 'renameSync').mockImplementation((...args) => {
    events.push('rename')
    actualSync.renameSync(...args)
  })
  changed.mockImplementation(() => events.push('changed'))
  const info = await fs.stat(join(home, 'new'))
  const paths = [join(home, 'original'), join(home, 'new')]
  await publishRepositoryConfig(options, paths, () => true, {
    home,
    expected: { path: join(home, 'new'), dev: info.dev, ino: info.ino },
  })
  expect(events).toEqual([
    'writeFile',
    'sync',
    'close',
    'identity',
    'rename',
    'store',
    'changed',
    'microtask',
  ])
  expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toMatchObject({
    repositories: paths,
    contextBudget: '400k',
  })
  expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  expect(changed).toHaveBeenCalledWith(paths)
  await noStagingFiles()
})

it.each(['writeFile', 'sync', 'rename'] as const)(
  'cleans staging and preserves config and store when %s fails',
  async (phase) => {
    const before = await fs.readFile(configPath, 'utf8')
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const closed = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closed()
        await close()
      })
      if (phase === 'writeFile') vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('write'))
      if (phase === 'sync') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync'))
      return handle
    })
    if (phase === 'rename')
      vi.spyOn(fsSync, 'renameSync').mockImplementation(() => {
        throw new Error('rename')
      })
    await expect(
      publishRepositoryConfig(options, [join(home, 'new')], () => true),
    ).rejects.toThrow()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(configPath, 'utf8')).toBe(before)
    expect(store.listRepositories().map((r) => r.path)).toEqual([join(home, 'original')])
    expect(changed).not.toHaveBeenCalled()
    await noStagingFiles()
  },
)

it('refuses authority loss or a stale identity before rename and cleans staging', async () => {
  const before = await fs.readFile(configPath, 'utf8')
  await expect(publishRepositoryConfig(options, [], () => false)).rejects.toMatchObject({
    code: 'forbidden',
  })
  await expect(
    publishRepositoryConfig(options, [join(home, 'new')], () => true, {
      home,
      expected: { path: join(home, 'new'), dev: 0, ino: 0 },
    }),
  ).rejects.toThrow()
  expect(await fs.readFile(configPath, 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
  await noStagingFiles()
})

it('rejects oversized output before staging and disabled or invalid config on load', async () => {
  await expect(
    publishRepositoryConfig(options, ['x'.repeat(65536)], () => true),
  ).rejects.toMatchObject({ code: 'too-large' })
  await noStagingFiles()
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  await fs.writeFile(configPath, JSON.stringify({ ...config, allowRepositoryChanges: false }))
  await expect(loadRepositoryConfig(options)).rejects.toMatchObject({ code: 'forbidden' })
  await fs.writeFile(configPath, '{')
  await expect(loadRepositoryConfig(options)).rejects.toMatchObject({ code: 'forbidden' })
  expect(changed).not.toHaveBeenCalled()
})
