import { constants, type PathLike } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { generateKeyPairSync, KeyObject } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errnoCode } from '../fs-safety'
import {
  checkIdentityDirectory,
  createIdentityStore,
  IdentityFailure,
  readIdentityFile,
  readIdentityFileSnapshot,
  type HostIdentity,
  type PendingEnrollment,
} from './identity'
import { freshKey, publicIdentity } from './signer'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    unlink: vi.fn(actual.unlink),
  }
})
const actualFs = await vi.importActual<typeof filesystem>('node:fs/promises')

const UNSAFE =
  'Unsafe identity storage. Use files owned by you, no symlinks, chmod 600 host-key.*.pem host.json and chmod 700 identity.'
const INCOMPLETE =
  'Identity incomplete. Use an owned regular key, no symlink, chmod 600 host-key.*.pem; run phosphor setup.'
const INVALID = 'Invalid identity. Run phosphor logout --local, then phosphor setup.'
const SAVE_FAILED = 'Identity save failed. Run phosphor status before retrying.'
const TOO_MANY = 'Too many identity files. Remove unused host-key files.'
const INVALID_PENDING = 'Invalid pending enrollment.'
const READ = String(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
const pendingFor = (key: KeyObject): PendingEnrollment => ({
  version: 1,
  controlUrl: identity.controlUrl,
  enrollmentId: hostId,
  userCode: 'BCDFGHJK',
  keyFingerprint: publicIdentity(key).keyFingerprint,
  expiresAt: '2026-10-10T00:10:00.000Z',
  savedAt: identity.savedAt,
  pollIntervalSec: 5,
})

let root: string
let dir: string
const events: string[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-identity-char-'))
  dir = join(root, 'identity')
  events.length = 0
})
afterEach(async () => {
  vi.mocked(filesystem.open).mockReset()
  vi.mocked(filesystem.lstat).mockReset()
  vi.mocked(filesystem.unlink).mockReset()
  await chmod(dir, 0o700).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})
const store = (owner = uid) => createIdentityStore(dir, owner)
const keyName = (id = hostId) => `host-key.${id}.pem`
const keyFile = (id = hostId) => join(dir, keyName(id))
const metadata = () => join(dir, 'host.json')
const pem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString()
const x25519 = () => generateKeyPairSync('x25519').privateKey
const exists = (path: string) => actualFs.lstat(path).then(Boolean, () => false)
const denied = () => Object.assign(new Error('denied'), { code: 'EACCES' })

/** Settle a store call into a comparable shape: value, failure class, message, classification. */
async function settle(work: Promise<unknown>) {
  try {
    const value = await work
    if (value !== null && typeof value === 'object' && 'key' in value)
      if (value.key instanceof KeyObject)
        return { resolved: { ...value, key: publicIdentity(value.key).keyFingerprint } }
    return { resolved: value }
  } catch (error) {
    if (error instanceof IdentityFailure)
      return { rejected: 'IdentityFailure', message: error.message, incomplete: error.incomplete }
    const known = error instanceof Error || error instanceof DOMException
    return {
      rejected: errnoCode(error) ?? (known ? error.name : typeof error),
      message: known ? error.message : String(error),
    }
  }
}
const failure = (message: string, incomplete?: HostIdentity) => ({
  rejected: 'IdentityFailure',
  message,
  incomplete,
})
const loadedWith = (key: KeyObject, loaded = identity) => ({
  resolved: { identity: loaded, key: publicIdentity(key).keyFingerprint },
})

/** Path as the trace shows it: relative to the identity directory, temp files as TMP. */
const show = (path: PathLike) => {
  const name = relative(dir, String(path))
  return /^\.host-[0-9a-f-]{36}\.tmp$/.test(name) ? 'TMP' : name || '.'
}
/** Record every lstat, unlink, open, sync and close the store makes, in order. */
function trace(unlinkFails?: (name: string) => boolean) {
  vi.mocked(filesystem.lstat).mockImplementation(async (path, options) => {
    events.push(`lstat ${show(path)}`)
    return actualFs.lstat(path, options)
  })
  vi.mocked(filesystem.unlink).mockImplementation(async (path) => {
    events.push(`unlink ${show(path)}`)
    if (unlinkFails?.(show(path))) throw denied()
    return actualFs.unlink(path)
  })
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actualFs.open(path, flags, mode)
    events.push(
      `open ${show(path)} ${String(flags)}${typeof mode === 'number' ? ` ${mode.toString(8)}` : ''}`,
    )
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
}
/** A rename port that traces, may fail one target, and may run a hook after a rename. */
function renamePort(fail?: string, after?: (to: string) => void) {
  return {
    rename: async (from: PathLike, to: PathLike) => {
      events.push(`rename ${show(from)} ${show(to)}`)
      if (show(to) === fail) throw new Error('rename failed')
      await actualFs.rename(from, to)
      after?.(show(to))
    },
  }
}
const write = (name: string) => [`open TMP wx 600`, 'sync', 'close', `rename TMP ${name}`]
const publish = (name: string) => [...write(name), 'unlink TMP']
const read = (name: string) => [`lstat ${name}`, `open ${name} ${READ}`, 'close']
/** The directory check and the orphan probe that open every save. */
const probe = (id = hostId) => ['lstat .', `lstat ${keyName(id)}`]

describe('identity load refusal matrix (characterization)', () => {
  const key = freshKey()
  const saveFixed = () => store().save(identity, key)
  const shape = (value: unknown) => async () => {
    await saveFixed()
    await writeFile(metadata(), JSON.stringify(value))
  }
  const meta = (change: Record<string, unknown>) => shape({ ...identity, ...change })
  /** Save the fixed pair, then run each step in order. */
  const saved =
    (...steps: (() => Promise<unknown>)[]) =>
    async () => {
      await saveFixed()
      for (const step of steps) await step()
    }
  const replaceWithDirectory = (path: () => string) =>
    saved(
      () => rm(path()),
      () => mkdir(path()),
    )
  const swapKey = (next: string) =>
    saved(
      () => rm(keyFile()),
      () => writeFile(keyFile(), next, { mode: 0o600 }),
    )
  const cases: [string, () => Promise<unknown>, unknown, number?][] = [
    ['missing directory', async () => undefined, { resolved: null }],
    ['empty directory', () => mkdir(dir, { mode: 0o700 }), { resolved: null }],
    ['directory file', () => writeFile(dir, '', { mode: 0o600 }), failure(UNSAFE)],
    ['directory group bit', saved(() => chmod(dir, 0o750)), failure(UNSAFE)],
    ['directory other uid', saved(), failure(UNSAFE), (uid ?? 0) + 1],
    ['directory without uid', saved(), failure(UNSAFE), -1],
    ['missing metadata', saved(() => rm(metadata())), { resolved: null }],
    ['metadata group bit', saved(() => chmod(metadata(), 0o640)), failure(UNSAFE)],
    ['metadata directory', replaceWithDirectory(metadata), failure(UNSAFE)],
    ['metadata 4097 bytes', saved(() => writeFile(metadata(), ' '.repeat(4097))), failure(UNSAFE)],
    ['malformed metadata', saved(() => writeFile(metadata(), '{')), failure(INVALID)],
    ['metadata array', shape([identity]), failure(INVALID)],
    ['metadata null', shape(null), failure(INVALID)],
    ['metadata string', shape('host'), failure(INVALID)],
    ['version 2', meta({ version: 2 }), failure(INVALID)],
    ['version string', meta({ version: '1' }), failure(INVALID)],
    ['missing controlUrl', meta({ controlUrl: undefined }), failure(INVALID)],
    ['public http controlUrl', meta({ controlUrl: 'http://public.example' }), failure(INVALID)],
    ['controlUrl with path', meta({ controlUrl: 'https://example.com/' }), failure(INVALID)],
    ['bad savedAt', meta({ savedAt: '2026-10-10T00:00:00Z' }), failure(INVALID)],
    ['missing ownerLogin', meta({ ownerLogin: undefined }), failure(INVALID)],
    ['bad ownerLogin', meta({ ownerLogin: 'bad login' }), failure(INVALID)],
    ['escaping hostId', meta({ hostId: '../escape' }), failure(INVALID)],
    ['uppercase hostId', meta({ hostId: hostId.toUpperCase() }), failure(INVALID)],
    ['empty label', meta({ label: '' }), failure(INVALID)],
    ['padded label', meta({ label: ' bee1 ' }), failure(INVALID)],
    ['missing key', saved(() => rm(keyFile())), failure(INCOMPLETE, identity)],
    ['key group bit', saved(() => chmod(keyFile(), 0o640)), failure(INCOMPLETE, identity)],
    ['key directory', replaceWithDirectory(keyFile), failure(INCOMPLETE, identity)],
    ['key 4097 bytes', swapKey('x'.repeat(4097)), failure(INCOMPLETE, identity)],
    ['key not PEM', swapKey('not a key'), failure(INCOMPLETE, identity)],
    ['key x25519', swapKey(pem(x25519())), failure(INCOMPLETE, identity)],
  ]
  it.each(cases)('load with %s', async (_name, setup, expected, owner) => {
    await setup()
    const loading = createIdentityStore(dir, owner === -1 ? undefined : (owner ?? uid))
    expect(await settle(loading.load())).toEqual(expected)
  })

  it.each([
    ['localhost http controlUrl', { controlUrl: 'http://localhost:8787' }],
    ['null ownerLogin', { ownerLogin: null }],
  ])('loads metadata with %s', async (_name, change) => {
    await saveFixed()
    await writeFile(metadata(), JSON.stringify({ ...identity, ...change }))
    expect(await settle(store().load())).toEqual(loadedWith(key, { ...identity, ...change }))
  })

  it('strips unknown metadata fields and loads any Ed25519 key stored under the host id', async () => {
    await saveFixed()
    await writeFile(metadata(), JSON.stringify({ secret: 'drop', ...identity, owner: 'x' }))
    const other = freshKey()
    await writeFile(keyFile(), pem(other))
    expect(await settle(store().load())).toEqual(loadedWith(other))
  })

  it('refuses symlinked directory, metadata and key with the same split', async () => {
    await saveFixed()
    await writeFile(join(root, 'host.json'), JSON.stringify(identity), { mode: 0o600 })
    await rm(metadata())
    await symlink(join(root, 'host.json'), metadata())
    expect(await settle(store().load())).toEqual(failure(UNSAFE))
    await rm(metadata())
    await writeFile(metadata(), JSON.stringify(identity), { mode: 0o600 })
    await writeFile(join(root, 'key.pem'), pem(key), { mode: 0o600 })
    await rm(keyFile())
    await symlink(join(root, 'key.pem'), keyFile())
    expect(await settle(store().load())).toEqual(failure(INCOMPLETE, identity))
    await rm(keyFile())
    await writeFile(keyFile(), pem(key), { mode: 0o600 })
    await actualFs.rename(dir, join(root, 'actual'))
    await symlink(join(root, 'actual'), dir)
    expect(await settle(store().load())).toEqual(failure(UNSAFE))
  })

  it('accepts files of exactly 4096 bytes', async () => {
    await saveFixed()
    for (const path of [metadata(), keyFile()]) {
      const text = await readFile(path, 'utf8')
      await writeFile(path, text + ' '.repeat(4096 - Buffer.byteLength(text)))
    }
    expect(await settle(store().load())).toEqual(loadedWith(key))
  })

  it.each([
    ['metadata', metadata, failure(UNSAFE)],
    ['key', keyFile, failure(INCOMPLETE, identity)],
  ])(
    'refuses %s that grows past 4096 bytes after the descriptor stat',
    async (_n, path, expected) => {
      await saveFixed()
      const text = await readFile(path(), 'utf8')
      await writeFile(path(), text + ' '.repeat(4097 - Buffer.byteLength(text)))
      vi.mocked(filesystem.open).mockImplementation(async (target, flags, mode) => {
        const handle = await actualFs.open(target, flags, mode)
        if (String(target) !== path()) return handle
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementation(async () =>
          Object.assign(await stat(), { size: 4096 }),
        )
        return handle
      })
      expect(await settle(store().load())).toEqual(expected)
    },
  )

  it('classifies a directory swapped during the key read as incomplete', async () => {
    await saveFixed()
    vi.mocked(filesystem.open).mockImplementation(async (target, flags, mode) => {
      const handle = await actualFs.open(target, flags, mode)
      if (String(target) !== keyFile()) return handle
      await actualFs.rename(dir, join(root, 'swapped'))
      await actualFs.mkdir(dir, { mode: 0o700 })
      for (const name of ['host.json', keyName()]) {
        await actualFs.copyFile(join(root, 'swapped', name), join(dir, name))
        await chmod(join(dir, name), 0o600)
      }
      return handle
    })
    expect(await settle(store().load())).toEqual(failure(INCOMPLETE, identity))
    vi.mocked(filesystem.open).mockReset()
    expect(await settle(store().load())).toEqual(loadedWith(key))
  })

  it('reads metadata, then the key, then rechecks the directory', async () => {
    await saveFixed()
    trace()
    expect(await settle(store().load())).toEqual(loadedWith(key))
    expect(events).toEqual(['lstat .', ...read('host.json'), ...read(keyName()), 'lstat .'])
  })
})

describe('identity file reads (characterization)', () => {
  it('reads a snapshot through a no-follow, non-blocking, read-only descriptor', async () => {
    await store().save(identity, freshKey())
    trace()
    const snapshot = await readIdentityFileSnapshot(dir, uid, 'host.json')
    expect(events).toEqual(read('host.json'))
    expect(snapshot.text).toBe(JSON.stringify(identity) + '\n')
    const info = await actualFs.lstat(metadata())
    expect([snapshot.info.ino, snapshot.info.dev, snapshot.info.size]).toEqual([
      info.ino,
      info.dev,
      info.size,
    ])
    expect(await readIdentityFile(dir, uid, 'host.json')).toBe(snapshot.text)
    expect((await checkIdentityDirectory(dir, uid)).ino).toBe((await actualFs.lstat(dir)).ino)
  })

  it('passes missing paths through as raw ENOENT and bounds reads at 4096 bytes', async () => {
    expect(await settle(checkIdentityDirectory(dir, uid))).toMatchObject({ rejected: 'ENOENT' })
    await mkdir(dir, { mode: 0o700 })
    expect(await settle(readIdentityFileSnapshot(dir, uid, 'host.json'))).toMatchObject({
      rejected: 'ENOENT',
    })
    await writeFile(metadata(), 'x'.repeat(4096), { mode: 0o600 })
    expect((await readIdentityFile(dir, uid, 'host.json')).length).toBe(4096)
    await writeFile(metadata(), 'x'.repeat(4097))
    expect(await settle(readIdentityFile(dir, uid, 'host.json'))).toEqual(failure(UNSAFE))
    await chmod(metadata(), 0o604)
    expect(await settle(readIdentityFile(dir, uid, 'host.json'))).toEqual(failure(UNSAFE))
  })
})

describe('identity save publication (characterization)', () => {
  it('publishes the key, then host.json, each through a synced temp file, then cleans keys', async () => {
    const first = freshKey()
    trace()
    await createIdentityStore(dir, uid, renamePort()).save(identity, first)
    expect(events).toEqual([...probe(), ...publish(keyName()), ...publish('host.json')])
    events.length = 0
    const second = freshKey()
    await createIdentityStore(dir, uid, renamePort()).save({ ...identity, hostId: otherId }, second)
    const published = [...publish(keyName(otherId)), ...publish('host.json')]
    expect(events).toEqual([...probe(otherId), ...published, `unlink ${keyName()}`])
    expect(await readFile(keyFile(otherId), 'utf8')).toBe(pem(second))
  })

  it('writes canonical metadata and drops unknown fields', async () => {
    const shuffled = {
      secret: 'drop',
      savedAt: identity.savedAt,
      ownerLogin: identity.ownerLogin,
      label: identity.label,
      hostId,
      controlUrl: identity.controlUrl,
      version: 1 as const,
    }
    await store().save(shuffled, freshKey())
    expect(await readFile(metadata(), 'utf8')).toBe(JSON.stringify(identity) + '\n')
  })

  it('keeps the earlier pair and the uncommitted key when the host.json rename fails', async () => {
    const old = freshKey()
    await store().save(identity, old)
    trace()
    const next = { ...identity, hostId: otherId }
    const broken = createIdentityStore(dir, uid, renamePort('host.json'))
    expect(await settle(broken.save(next, freshKey()))).toEqual(failure(SAVE_FAILED))
    expect(events).toEqual([
      ...probe(otherId),
      ...publish(keyName(otherId)),
      ...publish('host.json'),
    ])
    expect((await readdir(dir)).sort()).toEqual([keyName(), keyName(otherId), 'host.json'])
    expect(await settle(store().load())).toEqual(loadedWith(old))
  })

  it('never attempts host.json when the key rename fails', async () => {
    const old = freshKey()
    await store().save(identity, old)
    trace()
    const broken = createIdentityStore(dir, uid, renamePort(keyName(otherId)))
    const result = await settle(broken.save({ ...identity, hostId: otherId }, freshKey()))
    expect(result).toEqual(failure(SAVE_FAILED))
    expect(events).toEqual([...probe(otherId), ...publish(keyName(otherId))])
    expect((await readdir(dir)).sort()).toEqual([keyName(), 'host.json'])
    expect(await settle(store().load())).toEqual(loadedWith(old))
  })

  it('reuses an identical orphan only while host.json is absent, without rewriting it', async () => {
    const key = freshKey()
    await mkdir(dir, { mode: 0o700 })
    await writeFile(keyFile(), pem(key), { mode: 0o600 })
    const before = (await actualFs.lstat(keyFile())).ino
    trace()
    await createIdentityStore(dir, uid, renamePort()).save(identity, key)
    const reused = [...read(keyName()), 'lstat host.json']
    expect(events).toEqual([...probe(), ...reused, ...publish('host.json')])
    expect((await actualFs.lstat(keyFile())).ino).toBe(before)
    expect(await settle(store().load())).toEqual(loadedWith(key))
    expect(await settle(store().save(identity, key))).toEqual(failure(UNSAFE))
  })

  it.each([
    ['different bytes', (key: KeyObject) => pem(key) + '\n', false],
    ['identical bytes and committed host.json', pem, true],
  ])('refuses an orphan with %s', async (_name, contents, committed) => {
    if (committed) await store().save(identity, freshKey())
    else await mkdir(dir, { mode: 0o700 })
    const metadataBefore = committed ? await readFile(metadata(), 'utf8') : null
    const key = freshKey()
    await writeFile(keyFile(otherId), contents(key), { mode: 0o600 })
    trace()
    const result = await settle(store().save({ ...identity, hostId: otherId }, key))
    expect(result).toEqual(failure(UNSAFE))
    expect(events.some((event) => event.startsWith('open TMP'))).toBe(false)
    expect(events.includes('lstat host.json')).toBe(committed)
    expect(await readFile(keyFile(otherId), 'utf8')).toBe(contents(key))
    expect(committed ? await readFile(metadata(), 'utf8') : null).toBe(metadataBefore)
  })

  it('refuses a symlinked orphan and translates probe failures to a save failure', async () => {
    const key = freshKey()
    await mkdir(dir, { mode: 0o700 })
    await writeFile(join(root, 'key.pem'), pem(key), { mode: 0o600 })
    await symlink(join(root, 'key.pem'), keyFile())
    expect(await settle(store().save(identity, key))).toEqual(failure(UNSAFE))
    await rm(keyFile())
    const failProbe = (target: string) =>
      vi.mocked(filesystem.lstat).mockImplementation(async (path, options) => {
        if (String(path) === target) throw denied()
        return actualFs.lstat(path, options)
      })
    failProbe(keyFile())
    expect(await settle(store().save(identity, key))).toEqual(failure(SAVE_FAILED))
    await writeFile(keyFile(), pem(key), { mode: 0o600 })
    failProbe(metadata())
    expect(await settle(store().save(identity, key))).toEqual(failure(SAVE_FAILED))
    expect(await readdir(dir)).toEqual([keyName()])
  })
})

describe('identity save refusal precedence and cancellation (characterization)', () => {
  it('validates metadata, then the key type, then the uid, then the signal, before any disk access', async () => {
    const abort = new AbortController()
    abort.abort()
    const nobody = createIdentityStore(dir, undefined)
    const bad = { ...identity, hostId: '../escape' }
    expect(await settle(nobody.save(bad, x25519(), abort.signal))).toEqual(failure(INVALID))
    expect(await settle(nobody.save(identity, x25519(), abort.signal))).toEqual({
      rejected: 'Error',
      message: 'Identity key must be Ed25519.',
    })
    expect(await settle(nobody.save(identity, freshKey(), abort.signal))).toEqual(failure(UNSAFE))
    expect(await settle(store().save(identity, freshKey(), abort.signal))).toMatchObject({
      rejected: 'AbortError',
    })
    expect(await exists(dir)).toBe(false)
  })

  it('refuses an unsafe directory as is and translates a failed mkdir', async () => {
    await mkdir(dir, { mode: 0o750 })
    expect(await settle(store().save(identity, freshKey()))).toEqual(failure(UNSAFE))
    await writeFile(join(root, 'file'), '')
    const blocked = createIdentityStore(join(root, 'file', 'identity'), uid)
    expect(await settle(blocked.save(identity, freshKey()))).toEqual(failure(SAVE_FAILED))
  })

  it('aborted while the key temp file is written: no rename, temp removed, save failure', async () => {
    const old = freshKey()
    await store().save(identity, old)
    const abort = new AbortController()
    trace()
    const opening = vi.mocked(filesystem.open).getMockImplementation()
    vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
      if (show(path) === 'TMP') abort.abort()
      if (!opening) throw new Error('trace() installs open')
      return opening(path, flags, mode)
    })
    const saving = createIdentityStore(dir, uid, renamePort())
    const next = { ...identity, hostId: otherId }
    expect(await settle(saving.save(next, freshKey(), abort.signal))).toEqual(failure(SAVE_FAILED))
    expect(events).toEqual([...probe(otherId), 'open TMP wx 600', 'sync', 'close', 'unlink TMP'])
    expect((await readdir(dir)).sort()).toEqual([keyName(), 'host.json'])
    expect(await settle(store().load())).toEqual(loadedWith(old))
  })

  it('aborted between key and metadata: removes the new key after the temp file', async () => {
    const old = freshKey()
    await store().save(identity, old)
    const abort = new AbortController()
    trace()
    const port = renamePort(undefined, (to) => {
      if (to === keyName(otherId)) abort.abort()
    })
    const saving = createIdentityStore(dir, uid, port)
    const next = { ...identity, hostId: otherId }
    expect(await settle(saving.save(next, freshKey(), abort.signal))).toEqual(failure(SAVE_FAILED))
    const unpublished = ['open TMP wx 600', 'sync', 'close', 'unlink TMP']
    expect(events).toEqual([
      ...probe(otherId),
      ...publish(keyName(otherId)),
      ...unpublished,
      `unlink ${keyName(otherId)}`,
    ])
    expect((await readdir(dir)).sort()).toEqual([keyName(), 'host.json'])
    expect(await settle(store().load())).toEqual(loadedWith(old))
  })

  it('reports unsafe when cancelled key cleanup or temp cleanup cannot unlink', async () => {
    await store().save(identity, freshKey())
    const abort = new AbortController()
    trace((name) => name === keyName(otherId))
    const port = renamePort(undefined, (to) => {
      if (to === keyName(otherId)) abort.abort()
    })
    const next = { ...identity, hostId: otherId }
    const cancelled = createIdentityStore(dir, uid, port).save(next, freshKey(), abort.signal)
    expect(await settle(cancelled)).toEqual(failure(UNSAFE))
    expect((await readdir(dir)).sort()).toEqual([keyName(), keyName(otherId), 'host.json'])
    await rm(dir, { recursive: true })
    trace((name) => name === 'TMP')
    const key = freshKey()
    expect(await settle(store().save(identity, key))).toEqual(failure(UNSAFE))
    expect(await readdir(dir)).toEqual([keyName()])
    vi.mocked(filesystem.unlink).mockReset()
    expect(await settle(store().save(identity, key))).toEqual({ resolved: undefined })
    expect(await settle(store().load())).toEqual(loadedWith(key))
  })
})

describe('identity key cleanup and scan bound (characterization)', () => {
  it('removes only other host-key.<uuid>.pem files after the commit', async () => {
    await store().save(identity, freshKey())
    const kept = [
      'host-key.not-a-uuid.pem',
      'host-key.0b6f7c1e-2f4a-0c8e-9d1b-5a7e3c2f1d02.pem',
      `host-key.${otherId}.pem.bak`,
      'pending-key.pem',
      'unrelated',
    ]
    for (const name of kept) await writeFile(join(dir, name), 'keep', { mode: 0o600 })
    const key = freshKey()
    await store().save({ ...identity, hostId: otherId }, key)
    expect((await readdir(dir)).sort()).toEqual([...kept, keyName(otherId), 'host.json'].sort())
  })

  it('counts 1000 entries after the commit, refusing the 1001st with the identity kept', async () => {
    await mkdir(dir, { mode: 0o700 })
    for (let index = 0; index < 998; index++) await writeFile(join(dir, `unused-${index}`), '')
    const key = freshKey()
    expect(await settle(store().save(identity, key))).toEqual({ resolved: undefined })
    await store().remove()
    await writeFile(join(dir, 'unused-998'), '')
    expect(await settle(store().save(identity, key))).toEqual(failure(TOO_MANY))
    expect(await settle(store().load())).toEqual(loadedWith(key))
  })

  it('passes a key unlink failure through raw on removal and as a save failure after commit', async () => {
    await store().save(identity, freshKey())
    trace((name) => name === keyName())
    const key = freshKey()
    const next = { ...identity, hostId: otherId }
    expect(await settle(store().save(next, key))).toEqual(failure(SAVE_FAILED))
    expect(await settle(store().load())).toEqual(loadedWith(key, next))
    expect(await settle(store().remove())).toMatchObject({ rejected: 'EACCES' })
    expect(await exists(metadata())).toBe(false)
  })
})

describe('pending enrollment (characterization)', () => {
  it('writes the pending key before canonical metadata and reads them in the same order', async () => {
    const key = freshKey()
    trace()
    const saving = createIdentityStore(dir, uid, renamePort())
    const withUnknownField = { ...pendingFor(key), secret: 'drop' }
    await saving.savePending(withUnknownField, key)
    expect(events).toEqual(['lstat .', ...publish('pending-key.pem'), ...publish('pending.json')])
    expect(await readFile(join(dir, 'pending.json'), 'utf8')).toBe(
      JSON.stringify({
        version: 1,
        controlUrl: identity.controlUrl,
        savedAt: identity.savedAt,
        enrollmentId: hostId,
        userCode: 'BCDFGHJK',
        keyFingerprint: publicIdentity(key).keyFingerprint,
        expiresAt: '2026-10-10T00:10:00.000Z',
        pollIntervalSec: 5,
      }) + '\n',
    )
    events.length = 0
    expect(await settle(saving.loadPending())).toEqual({
      resolved: { enrollment: pendingFor(key), key: publicIdentity(key).keyFingerprint },
    })
    expect(events).toEqual(['lstat .', ...read('pending.json'), ...read('pending-key.pem')])
  })

  it('refuses invalid metadata, then a mismatched key, then a non-Ed25519 key', async () => {
    const key = freshKey()
    const bad = { ...pendingFor(key), version: 2 } as unknown as PendingEnrollment
    expect(await settle(store().savePending(bad, freshKey()))).toEqual(failure(INVALID_PENDING))
    expect(await settle(store().savePending(pendingFor(key), freshKey()))).toEqual(failure(UNSAFE))
    expect(await settle(store().savePending(pendingFor(key), x25519()))).toEqual({
      rejected: 'Error',
      message: 'Identity key must be Ed25519.',
    })
    expect(await exists(dir)).toBe(false)
    const nobody = createIdentityStore(dir, undefined)
    expect(await settle(nobody.savePending(pendingFor(key), key))).toEqual(failure(UNSAFE))
    expect(await readdir(dir)).toEqual([])
    await rm(dir, { recursive: true })
    await writeFile(join(root, 'file'), '')
    const blocked = createIdentityStore(join(root, 'file', 'identity'), uid)
    expect(await settle(blocked.savePending(pendingFor(key), key))).toMatchObject({
      rejected: 'ENOTDIR',
    })
  })

  it('passes cancellation through raw and leaves only what was published', async () => {
    const key = freshKey()
    const aborted = new AbortController()
    aborted.abort()
    expect(await settle(store().savePending(pendingFor(key), key, aborted.signal))).toMatchObject({
      rejected: 'AbortError',
    })
    expect(await readdir(dir)).toEqual([])
    const abort = new AbortController()
    const port = renamePort(undefined, (to) => {
      if (to === 'pending-key.pem') abort.abort()
    })
    const saving = createIdentityStore(dir, uid, port)
    expect(await settle(saving.savePending(pendingFor(key), key, abort.signal))).toMatchObject({
      rejected: 'AbortError',
    })
    expect(await readdir(dir)).toEqual(['pending-key.pem'])
    expect(await settle(store().loadPending())).toEqual({ resolved: null })
    await store().removePending()
    expect(await readdir(dir)).toEqual([])
    trace((name) => name === 'TMP')
    expect(await settle(store().savePending(pendingFor(key), key))).toEqual(failure(UNSAFE))
    expect(await readdir(dir)).toEqual(['pending-key.pem'])
  })

  it.each([
    ['another Ed25519 key', () => pem(freshKey()), true],
    ['an x25519 key', () => pem(x25519()), true],
    ['not a key', () => 'not a key', true],
    ['malformed metadata', null, false],
  ])('loads no pending enrollment with %s', async (_name, keyText, opensKey) => {
    const key = freshKey()
    await store().savePending(pendingFor(key), key)
    if (keyText) await writeFile(join(dir, 'pending-key.pem'), keyText())
    else await writeFile(join(dir, 'pending.json'), '{')
    trace()
    expect(await settle(store().loadPending())).toEqual({ resolved: null })
    expect(events.includes(`open pending-key.pem ${READ}`)).toBe(opensKey)
  })

  it('loads nothing from a missing or unsafe directory without opening a file', async () => {
    trace()
    expect(await settle(store().loadPending())).toEqual({ resolved: null })
    const key = freshKey()
    await store().savePending(pendingFor(key), key)
    await chmod(dir, 0o750)
    events.length = 0
    expect(await settle(store().loadPending())).toEqual({ resolved: null })
    expect(events).toEqual(['lstat .'])
  })

  it('removes only the pending pair and refuses what it cannot unlink', async () => {
    expect(await settle(store().removePending())).toEqual({ resolved: undefined })
    const key = freshKey()
    await store().save(identity, key)
    await store().savePending(pendingFor(key), key)
    await writeFile(join(dir, 'unrelated'), 'keep')
    await store().removePending()
    expect((await readdir(dir)).sort()).toEqual([keyName(), 'host.json', 'unrelated'])
    await store().removePending()
    await mkdir(join(dir, 'pending.json'))
    expect(await settle(store().removePending())).toEqual(failure(UNSAFE))
    await rm(join(dir, 'pending.json'), { recursive: true })
    await chmod(dir, 0o750)
    expect(await settle(store().removePending())).toEqual(failure(UNSAFE))
  })
})

describe('identity removal guard (characterization)', () => {
  const orphan = () => writeFile(keyFile(otherId), pem(freshKey()), { mode: 0o600 })

  it('removes metadata and every uuid key when the expected host matches', async () => {
    await store().save(identity, freshKey())
    await orphan()
    await writeFile(join(dir, 'pending-key.pem'), 'keep', { mode: 0o600 })
    trace()
    expect(await settle(store().remove(hostId))).toEqual({ resolved: undefined })
    expect(events.slice(0, 5)).toEqual(['lstat .', ...read('host.json'), 'unlink host.json'])
    expect(events.slice(5).sort()).toEqual([`unlink ${keyName()}`, `unlink ${keyName(otherId)}`])
    expect(await readdir(dir)).toEqual(['pending-key.pem'])
  })

  it('returns false and touches nothing when another host is committed', async () => {
    await store().save(identity, freshKey())
    await orphan()
    trace()
    expect(await settle(store().remove(otherId))).toEqual({ resolved: false })
    expect(events).toEqual(['lstat .', ...read('host.json')])
    expect((await readdir(dir)).sort()).toEqual([keyName(), keyName(otherId), 'host.json'])
  })

  it('still clears orphan keys when the expected host has no metadata', async () => {
    await mkdir(dir, { mode: 0o700 })
    await orphan()
    expect(await settle(store().remove(otherId))).toEqual({ resolved: undefined })
    expect(await readdir(dir)).toEqual([])
  })

  it.each([
    ['malformed metadata', () => writeFile(metadata(), '{'), { rejected: 'SyntaxError' }],
    ['invalid metadata', () => writeFile(metadata(), '{}'), failure(INVALID)],
    ['loosened metadata', () => chmod(metadata(), 0o644), failure(UNSAFE)],
  ])('refuses %s when an expected host is given', async (_name, setup, expected) => {
    await store().save(identity, freshKey())
    await setup()
    expect(await settle(store().remove(hostId))).toMatchObject(expected)
    expect((await readdir(dir)).sort()).toEqual([keyName(), 'host.json'])
    expect(await settle(store().remove())).toEqual({ resolved: undefined })
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses metadata it cannot unlink and an unsafe directory', async () => {
    await mkdir(dir, { mode: 0o700 })
    await mkdir(metadata())
    expect(await settle(store().remove())).toEqual(failure(UNSAFE))
    await rm(metadata(), { recursive: true })
    await chmod(dir, 0o750)
    expect(await settle(store().remove(hostId))).toEqual(failure(UNSAFE))
    expect(await settle(store((uid ?? 0) + 1).remove())).toEqual(failure(UNSAFE))
  })
})
