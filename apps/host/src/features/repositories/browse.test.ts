import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type HostStore } from '../../lanes/store'
import { homeDirectory } from '../repositories'
import { createFoldersFeature } from './browse'

vi.mock('node:fs/promises', { spy: true })
let home: string, outside: string, configPath: string, store: HostStore
let feature: ReturnType<typeof createFoldersFeature>
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'repository-browse-')))
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'repository-outside-')))
  configPath = join(home, 'config.json')
  await fs.mkdir(join(home, 'visible'))
  await fs.mkdir(join(home, '.hidden'))
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: '/usr/bin/pi' },
      repositories: [join(home, 'visible')],
    }),
    { mode: 0o600 },
  )
  store = await openStore(join(home, '.state'), process.getuid?.())
  store.syncRepositories([join(home, 'visible')])
  feature = createFoldersFeature(
    { home, configPath, uid: process.getuid?.(), store },
    homeDirectory,
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

it('confines canonical folders to home and returns canonical relative paths for aliases', async () => {
  await fs.mkdir(join(home, 'visible', 'child'))
  await fs.symlink(join(home, 'visible'), join(home, 'alias'))
  await fs.symlink(outside, join(home, 'escape'))
  expect(await feature.call('machine.folders.list', { path: 'alias' })).toMatchObject({
    ok: true,
    data: { path: 'visible', entries: [{ name: 'child' }], truncated: false },
  })
  expect(await feature.call('machine.folders.list', { path: 'escape' })).toMatchObject({
    ok: false,
    error: { code: 'bad-request' },
  })
  for (const path of ['../', '/tmp', 'visible/../']) {
    expect(await feature.call('machine.folders.list', { path })).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  }
})

it('sorts directories, hides dot entries by default, and marks git files and configured roots', async () => {
  await fs.mkdir(join(home, 'alpha'))
  await fs.mkdir(join(home, 'alpha', '.git'))
  await fs.writeFile(join(home, 'visible', '.git'), 'gitdir: elsewhere')
  await fs.writeFile(join(home, 'file'), '')
  await fs.symlink(outside, join(home, 'escape'))
  await fs.symlink(join(home, 'visible'), join(home, 'alias'))
  expect(await feature.call('machine.folders.list', {})).toEqual({
    ok: true,
    data: {
      path: '',
      truncated: false,
      entries: [
        { name: 'alpha', isRepository: true, configured: false },
        { name: 'visible', isRepository: true, configured: true },
      ],
    },
  })
  const hidden = await feature.call('machine.folders.list', { hidden: true })
  expect(hidden).toMatchObject({ ok: true })
  expect(JSON.stringify(hidden)).toContain('"name":".hidden"')
  expect(JSON.stringify(hidden)).not.toContain('"name":"escape"')
  expect(JSON.stringify(hidden)).not.toContain('"name":"alias"')
})

it('rechecks changes policy after scanning and rejects malformed params before resolution', async () => {
  const resolve = vi.fn(homeDirectory)
  feature = createFoldersFeature({ home, configPath, uid: process.getuid?.(), store }, resolve)
  expect(await feature.call('machine.folders.list', { hidden: 'yes' })).toMatchObject({
    ok: false,
    error: { code: 'bad-request' },
  })
  expect(resolve).not.toHaveBeenCalled()
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.spyOn(fs, 'opendir').mockImplementation(async (path) => {
    const config = JSON.parse(await actual.readFile(configPath, 'utf8'))
    await actual.writeFile(configPath, JSON.stringify({ ...config, allowRepositoryChanges: false }))
    return actual.opendir(path)
  })
  expect(await feature.call('machine.folders.list', {})).toMatchObject({
    ok: false,
    error: { code: 'forbidden' },
  })
})

async function repeatedEntries(kind: 'directory' | 'file', count: number) {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  const entries = await actual.readdir(home, { withFileTypes: true })
  const sample = entries.find((entry) =>
    kind === 'directory' ? entry.name === 'visible' : entry.isFile(),
  )!
  vi.spyOn(fs, 'opendir').mockImplementation(async (path) => {
    const directory = await actual.opendir(path)
    directory[Symbol.asyncIterator] = async function* () {
      try {
        for (let i = 0; i < count; i++) yield sample
      } finally {
        await directory.close()
      }
      return undefined
    }
    return directory
  })
}

it.each([20000, 20001])('bounds scanning at exactly 20000 entries (%i supplied)', async (count) => {
  await repeatedEntries('file', count)
  expect(await feature.call('machine.folders.list', {})).toEqual({
    ok: true,
    data: { path: '', entries: [], truncated: count > 20000 },
  })
})

it.each([500, 501])('bounds emitted folders at exactly 500 (%i supplied)', async (count) => {
  await repeatedEntries('directory', count)
  const result = await feature.call('machine.folders.list', {})
  expect(result).toMatchObject({ ok: true, data: { path: '', truncated: count > 500 } })
  expect(JSON.stringify(result).match(/"name":/g)).toHaveLength(500)
})
