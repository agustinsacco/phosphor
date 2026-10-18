import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkIdentityDirectory,
  createIdentityStore,
  IdentityFailure,
  readIdentityFileSnapshot,
  type HostIdentity,
  type PendingEnrollment,
} from './identity'
import { freshKey, publicIdentity } from './signer'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) }
})
const actualFs = await vi.importActual<typeof filesystem>('node:fs/promises')

const UNSAFE =
  'Unsafe identity storage. Use files owned by you, no symlinks, chmod 600 host-key.*.pem host.json and chmod 700 identity.'
const INCOMPLETE =
  'Identity incomplete. Use an owned regular key, no symlink, chmod 600 host-key.*.pem; run phosphor setup.'
const uid = process.getuid?.()
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const identity: HostIdentity = {
  version: 1,
  controlUrl: 'https://example.com',
  hostId,
  label: 'bee1',
  ownerLogin: 'me',
  savedAt: '2026-10-10T00:00:00.000Z',
}
const GROUP_OR_OTHER_BITS = [
  ['group read', 0o040],
  ['group write', 0o020],
  ['group execute', 0o010],
  ['other read', 0o004],
  ['other write', 0o002],
  ['other execute', 0o001],
] as const

let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-identity-fs-'))
  dir = join(root, 'identity')
})
afterEach(async () => {
  vi.mocked(filesystem.open).mockReset()
  vi.mocked(filesystem.lstat).mockReset()
  await chmod(dir, 0o700).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})
const store = (owner = uid) => createIdentityStore(dir, owner)
const keyFile = () => join(dir, `host-key.${hostId}.pem`)
const metadata = () => join(dir, 'host.json')
const saved = () => store().save(identity, freshKey())

/** Settle and describe the result, so each refusal pins class, message and classification. */
async function outcome(work: Promise<unknown>) {
  try {
    const value = await work
    return { value: value === null || value === undefined ? value : 'value' }
  } catch (error) {
    return {
      failure: error instanceof IdentityFailure,
      message: error instanceof Error ? error.message : String(error),
      incomplete: error instanceof IdentityFailure ? error.incomplete : 'not an IdentityFailure',
    }
  }
}
const unsafe = { failure: true, message: UNSAFE, incomplete: undefined }
const incomplete = { failure: true, message: INCOMPLETE, incomplete: identity }
const loaded = { value: 'value' }
const opened = (path: string) =>
  vi.mocked(filesystem.open).mock.calls.some(([target]) => String(target) === path)

/** lstat reports `change` for `target`, as if another user owned or loosened it. */
function lstatReports(target: string, change: Record<string, unknown>) {
  vi.mocked(filesystem.lstat).mockImplementation(async (path, options) => {
    const info = await actualFs.lstat(path, options)
    return String(path) === target ? Object.assign(info, change) : info
  })
}
/** The opened descriptor reports `change`, as if the path was swapped after lstat. */
function descriptorReports(target: string, change: Record<string, unknown>) {
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actualFs.open(path, flags, mode)
    if (String(path) !== target) return handle
    const stat = handle.stat.bind(handle)
    vi.spyOn(handle, 'stat').mockImplementation(async () => Object.assign(await stat(), change))
    return handle
  })
}

describe('identity storage ownership refusals (characterization)', () => {
  it('refuses every operation without a uid, and never opens a file for it', async () => {
    await saved()
    const nobody = createIdentityStore(dir, undefined)
    expect(await outcome(nobody.load())).toEqual(unsafe)
    expect(await outcome(nobody.save(identity, freshKey()))).toEqual(unsafe)
    expect(await outcome(nobody.remove())).toEqual(unsafe)
    expect(await outcome(nobody.removePending())).toEqual(unsafe)
    expect(await outcome(nobody.loadPending())).toEqual({ value: null })
    expect(await outcome(checkIdentityDirectory(dir, undefined))).toEqual(unsafe)
    vi.mocked(filesystem.open).mockClear()
    expect(await outcome(readIdentityFileSnapshot(dir, undefined, 'host.json'))).toEqual(unsafe)
    expect(opened(metadata())).toBe(false)
    expect(await outcome(store().load())).toEqual(loaded)
  })

  it('refuses a directory owned by another uid on load, save and removal', async () => {
    await saved()
    const other = store((uid ?? 0) + 1)
    expect(await outcome(other.load())).toEqual(unsafe)
    expect(await outcome(other.save(identity, freshKey()))).toEqual(unsafe)
    expect(await outcome(other.remove())).toEqual(unsafe)
    expect(await outcome(other.removePending())).toEqual(unsafe)
    expect(await outcome(store().load())).toEqual(loaded)
  })

  it.each(GROUP_OR_OTHER_BITS)('refuses a directory with %s', async (_name, bit) => {
    await saved()
    await chmod(dir, 0o700 | bit)
    expect(await outcome(store().load())).toEqual(unsafe)
    expect(await outcome(store().save(identity, freshKey()))).toEqual(unsafe)
    expect(await outcome(store().remove())).toEqual(unsafe)
    expect(await outcome(checkIdentityDirectory(dir, uid))).toEqual(unsafe)
  })

  it.each(GROUP_OR_OTHER_BITS)(
    'refuses metadata as unsafe and a key as incomplete with %s',
    async (_name, bit) => {
      await saved()
      await chmod(metadata(), 0o600 | bit)
      expect(await outcome(store().load())).toEqual(unsafe)
      await chmod(metadata(), 0o600)
      await chmod(keyFile(), 0o600 | bit)
      expect(await outcome(store().load())).toEqual(incomplete)
    },
  )

  it('refuses symlinked and non-directory identity folders, and treats a missing one as empty', async () => {
    expect(await outcome(store().load())).toEqual({ value: null })
    expect(await outcome(store().remove())).toEqual({ value: undefined })
    expect(await outcome(store().removePending())).toEqual({ value: undefined })
    await saved()
    await rename(dir, join(root, 'actual'))
    await symlink(join(root, 'actual'), dir)
    expect(await outcome(store().load())).toEqual(unsafe)
    expect(await outcome(store().remove())).toEqual(unsafe)
    await rm(dir)
    await writeFile(dir, '', { mode: 0o600 })
    expect(await outcome(store().load())).toEqual(unsafe)
    expect(await outcome(checkIdentityDirectory(dir, uid))).toEqual(unsafe)
  })

  it('refuses symlinked, non-file and oversized metadata; missing metadata is not enrolled', async () => {
    await saved()
    await rm(metadata())
    expect(await outcome(store().load())).toEqual({ value: null })
    await writeFile(join(root, 'host.json'), JSON.stringify(identity), { mode: 0o600 })
    await symlink(join(root, 'host.json'), metadata())
    expect(await outcome(store().load())).toEqual(unsafe)
    await rm(metadata())
    await mkdir(metadata(), { mode: 0o700 })
    expect(await outcome(store().load())).toEqual(unsafe)
    await rm(metadata(), { recursive: true })
    await writeFile(metadata(), ' '.repeat(4097), { mode: 0o600 })
    expect(await outcome(store().load())).toEqual(unsafe)
  })

  it('classifies a symlinked, non-file, oversized or missing key as incomplete', async () => {
    await saved()
    await rm(keyFile())
    expect(await outcome(store().load())).toEqual(incomplete)
    await writeFile(join(root, 'key.pem'), freshKey().export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    })
    await symlink(join(root, 'key.pem'), keyFile())
    expect(await outcome(store().load())).toEqual(incomplete)
    await rm(keyFile())
    await mkdir(keyFile(), { mode: 0o700 })
    expect(await outcome(store().load())).toEqual(incomplete)
    await rm(keyFile(), { recursive: true })
    await writeFile(keyFile(), 'x'.repeat(4097), { mode: 0o600 })
    expect(await outcome(store().load())).toEqual(incomplete)
  })

  it('refuses a file another uid owns before opening it', async () => {
    await saved()
    vi.mocked(filesystem.open).mockClear()
    lstatReports(metadata(), { uid: (uid ?? 0) + 1 })
    expect(await outcome(store().load())).toEqual(unsafe)
    expect(opened(metadata())).toBe(false)
    lstatReports(keyFile(), { uid: (uid ?? 0) + 1 })
    expect(await outcome(store().load())).toEqual(incomplete)
    expect(opened(keyFile())).toBe(false)
  })

  it.each([
    ['another uid', { uid: (uid ?? 0) + 1 }],
    ['a group bit', { mode: 0o100640 }],
    ['an other bit', { mode: 0o100601 }],
    ['more than 4 KiB', { size: 4097 }],
    ['not a regular file', { isFile: () => false }],
  ])('refuses an opened descriptor that reports %s', async (_name, change) => {
    await saved()
    descriptorReports(metadata(), change)
    expect(await outcome(store().load())).toEqual(unsafe)
    descriptorReports(keyFile(), change)
    expect(await outcome(store().load())).toEqual(incomplete)
  })

  it('counts only an Error carrying ENOENT as missing', async () => {
    await saved()
    const reject = (reason: unknown) =>
      vi.mocked(filesystem.lstat).mockImplementation(async (path, options) => {
        if (String(path) === dir) throw reason
        return actualFs.lstat(path, options)
      })
    reject({ code: 'ENOENT' })
    expect(await outcome(store().load())).toEqual(unsafe)
    expect(await outcome(store().remove())).toEqual(unsafe)
    reject('ENOENT')
    expect(await outcome(store().load())).toEqual(unsafe)
    reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(await outcome(store().load())).toEqual({ value: null })
    expect(await outcome(store().remove())).toEqual({ value: undefined })
    reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await outcome(store().load())).toEqual(unsafe)
  })
})

describe('identity storage owner-only predicate (characterization)', () => {
  it.each([
    ['0700', 0o700],
    ['0500', 0o500],
    ['0300', 0o300],
    ['0100', 0o100],
  ])('accepts directory mode %s, with or without owner read and write', async (_name, mode) => {
    await saved()
    await chmod(dir, mode)
    expect(await outcome(store().load())).toEqual(loaded)
    expect(await outcome(checkIdentityDirectory(dir, uid))).toEqual(loaded)
  })

  it.each([
    ['0700', 0o700],
    ['0500', 0o500],
    ['0400', 0o400],
    ['0600', 0o600],
  ])('accepts metadata and key mode %s, including owner execute', async (_name, mode) => {
    await saved()
    await chmod(metadata(), mode)
    await chmod(keyFile(), mode)
    expect(await outcome(store().load())).toEqual(loaded)
  })

  it('opens a file with no owner permission bits, so only the open itself can refuse it', async () => {
    await saved()
    await chmod(keyFile(), 0o000)
    vi.mocked(filesystem.open).mockClear()
    expect(await outcome(store().load())).toEqual(uid === 0 ? loaded : incomplete)
    expect(opened(keyFile())).toBe(true)
    await chmod(keyFile(), 0o600)
    await chmod(metadata(), 0o000)
    vi.mocked(filesystem.open).mockClear()
    expect(await outcome(store().load())).toEqual(uid === 0 ? loaded : unsafe)
    expect(opened(metadata())).toBe(true)
    await chmod(metadata(), 0o600)
  })

  it('loads a pending enrollment whose files are owner read-only', async () => {
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
    await store().savePending(pending, key)
    for (const name of ['pending.json', 'pending-key.pem']) await chmod(join(dir, name), 0o400)
    expect((await store().loadPending())?.enrollment).toEqual(pending)
    await chmod(join(dir, 'pending.json'), 0o440)
    expect(await store().loadPending()).toBeNull()
  })
})
