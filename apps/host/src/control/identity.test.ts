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
  type PendingEnrollment,
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
  it('remove(expected) changes nothing if a replacement identity is committed', async () => {
    await store().save(identity, freshKey())
    await store().save({ ...identity, hostId: otherId }, freshKey())
    const before = await readdir(dir)
    expect(await store().remove(hostId)).toBe(false)
    expect(await readdir(dir)).toEqual(before)
    expect((await store().load())?.identity.hostId).toBe(otherId)
    await store().remove(otherId)
    expect(await store().load()).toBeNull()
  })
  it('writes pending key before metadata, keeps owner-only modes, and cleanKeys never removes pending', async () => {
    const key = freshKey()
    const pending: PendingEnrollment = {
      version: 1,
      controlUrl: identity.controlUrl,
      enrollmentId: hostId,
      userCode: 'BCDFGHJK',
      keyFingerprint: publicIdentity(key).keyFingerprint,
      expiresAt: '2026-10-10T00:10:00.000Z',
      savedAt: identity.savedAt,
      pollIntervalSec: 5,
    }
    const operations: string[] = []
    const saving = createIdentityStore(dir, uid, {
      rename: async (from, to) => {
        operations.push(String(to))
        await rename(from, to)
      },
    })
    await saving.savePending(pending, key)
    expect(operations).toEqual([join(dir, 'pending-key.pem'), join(dir, 'pending.json')])
    for (const name of ['pending-key.pem', 'pending.json'])
      expect((await lstat(join(dir, name))).mode & 0o777).toBe(0o600)
    expect((await saving.loadPending())?.enrollment).toEqual(pending)
    await saving.save(identity, key)
    const loaded = await saving.loadPending()
    if (!loaded) throw new Error('Expected a pending enrollment')
    expect(publicIdentity(loaded.key)).toEqual(publicIdentity(key))
    await saving.remove()
    expect(await readFile(join(dir, 'pending-key.pem'), 'utf8')).toContain('PRIVATE KEY')
    await saving.removePending()
    expect(await readdir(dir)).toEqual([])
  })
  it.each([
    ['version', 2],
    ['controlUrl', 'http://public.example'],
    ['enrollmentId', '../escape'],
    ['userCode', 'bad'],
    ['keyFingerprint', 'bad'],
    ['expiresAt', '2026-10-10T00:00:00Z'],
    ['savedAt', 'bad'],
    ['pollIntervalSec', 0],
    ['pollIntervalSec', 61],
    ['pollIntervalSec', undefined],
  ])('refuses pending metadata %s = %s', async (field, value) => {
    await mkdir(dir, { mode: 0o700 })
    const key = freshKey()
    const pending = {
      version: 1,
      controlUrl: identity.controlUrl,
      enrollmentId: hostId,
      userCode: 'BCDFGHJK',
      keyFingerprint: publicIdentity(key).keyFingerprint,
      expiresAt: '2026-10-10T00:10:00.000Z',
      savedAt: identity.savedAt,
      pollIntervalSec: 5,
      [field]: value,
    }
    await writeFile(join(dir, 'pending.json'), JSON.stringify(pending), { mode: 0o600 })
    await writeFile(join(dir, 'pending-key.pem'), key.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    })
    expect(await store().loadPending()).toBeNull()
  })
  it.each([
    'key symlink',
    'metadata symlink',
    'key mode',
    'metadata mode',
    'key size',
    'metadata size',
  ])('safely rejects pending %s', async (problem) => {
    const key = freshKey()
    await store().savePending(
      {
        version: 1,
        controlUrl: identity.controlUrl,
        enrollmentId: hostId,
        userCode: 'BCDFGHJK',
        keyFingerprint: publicIdentity(key).keyFingerprint,
        expiresAt: '2026-10-10T00:10:00.000Z',
        savedAt: identity.savedAt,
        pollIntervalSec: 5,
      },
      key,
    )
    const path = join(dir, problem.startsWith('key') ? 'pending-key.pem' : 'pending.json')
    if (problem.endsWith('mode')) await chmod(path, 0o644)
    else if (problem.endsWith('size')) await writeFile(path, ' '.repeat(4097))
    else {
      await rename(path, join(root, 'outside'))
      await symlink(join(root, 'outside'), path)
    }
    expect(await store().loadPending()).toBeNull()
    await store().removePending()
    expect(await readdir(dir)).toEqual([])
  })
  it('refuses an orphan with the same key but different bytes', async () => {
    const key = freshKey()
    const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString()
    await filesystem.mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(keyFile(otherId), pem + '\n', { mode: 0o600 })
    await expect(store().save({ ...identity, hostId: otherId }, key)).rejects.toThrow(
      'Unsafe identity',
    )
    expect(await readFile(keyFile(otherId), 'utf8')).toBe(pem + '\n')
    expect(await store().load()).toBeNull()
  })
  it('refuses an identical orphan when host.json commits a different identity', async () => {
    await store().save(identity, freshKey())
    const key = freshKey()
    await writeFile(keyFile(otherId), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    await expect(store().save({ ...identity, hostId: otherId }, key)).rejects.toThrow(
      'Unsafe identity',
    )
    expect((await store().load())?.identity).toEqual(identity)
  })
  it.each([1, 60])('accepts pending poll interval boundary %s', async (pollIntervalSec) => {
    const key = freshKey()
    await store().savePending(
      {
        version: 1,
        controlUrl: identity.controlUrl,
        enrollmentId: hostId,
        userCode: 'BCDFGHJK',
        keyFingerprint: publicIdentity(key).keyFingerprint,
        expiresAt: '2026-10-10T00:10:00.000Z',
        savedAt: identity.savedAt,
        pollIntervalSec,
      },
      key,
    )
    expect((await store().loadPending())?.enrollment.pollIntervalSec).toBe(pollIntervalSec)
  })
})
