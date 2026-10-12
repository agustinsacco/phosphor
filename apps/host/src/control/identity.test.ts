import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIdentityStore,
  identityDirectory,
  IdentityFailure,
  type HostIdentity,
} from './identity'
import { freshKey, publicIdentity } from './signer'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) }
})

const uid = process.getuid?.()
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const otherId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01'
const identity: HostIdentity = {
  version: 1,
  controlUrl: 'https://example.com',
  hostId,
  label: 'bee1',
  ownerLogin: 'me',
  savedAt: '2026-10-10T00:00:00.000Z',
}
let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-identity-'))
  dir = join(root, 'identity')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const store = () => createIdentityStore(dir, uid)
const keyFile = (id = hostId) => join(dir, `host-key.${id}.pem`)

describe('Host identity storage', () => {
  it('uses the config file directory, including --config FILE', () => {
    expect(identityDirectory('/xdg/phosphor-host/config.json')).toBe('/xdg/phosphor-host/identity')
  })
  it('saves key before the commit point, with owner-only modes, then cleans obsolete keys', async () => {
    const key = freshKey()
    const operations: string[] = []
    const saving = createIdentityStore(dir, uid, {
      rename: async (from, to) => {
        operations.push(String(to))
        return rename(from, to)
      },
    })
    await saving.save(identity, key)
    expect(operations).toEqual([keyFile(), join(dir, 'host.json')])
    for (const [file, mode] of [
      [dir, 0o700],
      [keyFile(), 0o600],
      [join(dir, 'host.json'), 0o600],
    ] as const)
      expect((await lstat(file)).mode & 0o777).toBe(mode)
    expect(JSON.parse(await readFile(join(dir, 'host.json'), 'utf8'))).toEqual(identity)
    const loaded = await saving.load()
    expect(loaded && publicIdentity(loaded.key)).toEqual(publicIdentity(key))
    await saving.save({ ...identity, hostId: otherId }, freshKey())
    expect((await readdir(dir)).sort()).toEqual([`host-key.${otherId}.pem`, 'host.json'])
    expect((await saving.load())?.identity.hostId).toBe(otherId)
  })
  it.each([
    'key mode',
    'key symlink',
    'key directory',
    'missing key',
    'oversized key',
    'invalid key',
  ])('refuses %s as incomplete without using it', async (problem) => {
    await store().save(identity, freshKey())
    if (problem === 'key mode') await chmod(keyFile(), 0o644)
    else {
      await rm(keyFile())
      if (problem === 'key symlink') {
        await writeFile(
          join(root, 'key.pem'),
          freshKey().export({ type: 'pkcs8', format: 'pem' }),
          { mode: 0o600 },
        )
        await symlink(join(root, 'key.pem'), keyFile())
      }
      if (problem === 'key directory') await mkdir(keyFile(), { mode: 0o700 })
      if (problem === 'oversized key') await writeFile(keyFile(), 'x'.repeat(4097), { mode: 0o600 })
      if (problem === 'invalid key') await writeFile(keyFile(), 'not a key', { mode: 0o600 })
    }
    const opening = vi.mocked(filesystem.open)
    opening.mockClear()
    await expect(store().load()).rejects.toMatchObject({
      incomplete: identity,
      message: expect.stringContaining('run phosphor login'),
    })
    if (['key mode', 'key symlink', 'key directory'].includes(problem)) {
      expect(opening.mock.calls.some(([path]) => String(path) === keyFile())).toBe(false)
    }
  })
  it.each([
    'metadata mode',
    'metadata symlink',
    'metadata directory',
    'directory mode',
    'directory symlink',
    'wrong owner',
    'no uid',
    'invalid metadata',
    'oversized metadata',
  ])('refuses %s', async (problem) => {
    await store().save(identity, freshKey())
    let loading = store()
    if (problem === 'metadata mode') await chmod(join(dir, 'host.json'), 0o644)
    if (problem === 'directory mode') await chmod(dir, 0o755)
    if (problem === 'metadata symlink' || problem === 'metadata directory') {
      await rm(join(dir, 'host.json'))
      if (problem === 'metadata symlink') {
        await writeFile(join(root, 'host.json'), JSON.stringify(identity), { mode: 0o600 })
        await symlink(join(root, 'host.json'), join(dir, 'host.json'))
      } else await mkdir(join(dir, 'host.json'))
    }
    if (problem === 'directory symlink') {
      await rename(dir, join(root, 'actual'))
      await symlink(join(root, 'actual'), dir)
    }
    if (problem === 'wrong owner') loading = createIdentityStore(dir, (uid ?? 0) + 1)
    if (problem === 'no uid') loading = createIdentityStore(dir, undefined)
    if (problem === 'invalid metadata') await writeFile(join(dir, 'host.json'), '{')
    if (problem === 'oversized metadata') await writeFile(join(dir, 'host.json'), ' '.repeat(4097))
    const stating = vi.mocked(filesystem.lstat)
    stating.mockClear()
    await expect(loading.load()).rejects.toBeInstanceOf(IdentityFailure)
    if (problem === 'wrong owner') expect(stating.mock.calls).toHaveLength(1)
  })
  it('rejects bad host ids before constructing a key path and strips unknown disk fields', async () => {
    await expect(store().save({ ...identity, hostId: '../escape' }, freshKey())).rejects.toThrow(
      'Invalid identity',
    )
    await store().save(identity, freshKey())
    await writeFile(join(dir, 'host.json'), JSON.stringify({ ...identity, secret: 'discard' }))
    expect((await store().load())?.identity).toEqual(identity)
  })
  it.each([1, 2])(
    'keeps the earlier identity and removes temp files when rename %i fails',
    async (failAt) => {
      const old = freshKey()
      await store().save(identity, old)
      let renames = 0
      const broken = createIdentityStore(dir, uid, {
        rename: async (from, to) => {
          if (++renames === failAt) throw new Error('failure')
          await rename(from, to)
        },
      })
      await expect(broken.save({ ...identity, hostId: otherId }, freshKey())).rejects.toThrow(
        'Identity save failed',
      )
      expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false)
      expect((await store().load())?.identity).toEqual(identity)
      const loaded = await store().load()
      expect(loaded && publicIdentity(loaded.key)).toEqual(publicIdentity(old))
      // A successfully renamed but uncommitted key is harmless and cleaned on the next save.
      await store().remove()
      expect(await readdir(dir)).toEqual([])
    },
  )
  it('cancels between key and metadata without replacing the earlier identity', async () => {
    await store().save(identity, freshKey())
    const abort = new AbortController()
    const cancelling = createIdentityStore(dir, uid, {
      rename: async (from, to) => {
        await rename(from, to)
        if (String(to) === keyFile(otherId)) abort.abort()
      },
    })
    await expect(
      cancelling.save({ ...identity, hostId: otherId }, freshKey(), abort.signal),
    ).rejects.toThrow()
    expect((await store().load())?.identity).toEqual(identity)
    expect((await readdir(dir)).sort()).toEqual([`host-key.${hostId}.pem`, 'host.json'])
  })

  it('will not overwrite a committed key and leaves unrelated files alone on removal', async () => {
    const key = freshKey()
    await store().save(identity, key)
    await expect(store().save(identity, freshKey())).rejects.toThrow('Unsafe identity')
    await writeFile(join(dir, 'unrelated'), 'keep')
    await store().remove()
    expect(await readFile(join(dir, 'unrelated'), 'utf8')).toBe('keep')
    expect(await store().load()).toBeNull()
  })
  it('accepts exactly 4 KiB files and bounds the directory scan', async () => {
    await store().save(identity, freshKey())
    for (const path of [keyFile(), join(dir, 'host.json')]) {
      const text = await readFile(path, 'utf8')
      await writeFile(path, text + ' '.repeat(4096 - Buffer.byteLength(text)))
    }
    expect((await store().load())?.identity).toEqual(identity)
    const keyText = await readFile(keyFile(), 'utf8')
    await writeFile(keyFile(), keyText + ' ')
    await expect(store().load()).rejects.toMatchObject({ incomplete: identity })
    await writeFile(keyFile(), keyText)
    const metadata = await readFile(join(dir, 'host.json'), 'utf8')
    await writeFile(join(dir, 'host.json'), metadata + ' ')
    await expect(store().load()).rejects.toBeInstanceOf(IdentityFailure)
    await store().remove()
    for (let index = 0; index < 1000; index++) await writeFile(join(dir, `unused-${index}`), '')
    await expect(store().remove()).resolves.toBeUndefined()
    await writeFile(join(dir, 'unused-past-limit'), '')
    await expect(store().remove()).rejects.toThrow('Too many identity files')
  })

  it('treats missing metadata or directory as not enrolled', async () => {
    expect(await store().load()).toBeNull()
    await mkdir(dir, { mode: 0o700 })
    expect(await store().load()).toBeNull()
    await store().remove()
  })
})
