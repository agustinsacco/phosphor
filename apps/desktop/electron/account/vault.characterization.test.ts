import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVault, VaultUnreadable, type Storage } from './vault'
import { fakeCipher, fakeSeal, USER } from './__fixtures__/fakes'

// Real files, but every call is recorded and any one can be failed on demand.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>()
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
    renameSync: vi.fn(actual.renameSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    rmSync: vi.fn(actual.rmSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})
const real = await vi.importActual<typeof FileSystem>('node:fs')
const fsSpies = [
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
].map((spy) => vi.mocked(spy))

/** Forgets fixture calls, keeping a test's own spies and any injected failure. */
function clearFs(): void {
  for (const spy of fsSpies) spy.mockClear()
}

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phx-vault-char-'))
  dir = join(root, 'account')
  vi.clearAllMocks()
})
afterEach(() => {
  vi.resetAllMocks()
  real.rmSync(root, { recursive: true, force: true })
})

const owner = process.getuid?.()
const token = () => randomBytes(32).toString('base64url')
const file = (name: string) => join(dir, name)
const listed = () => readdirSync(dir).sort()
const LINUX_PLAIN = 'removed a plain sign-in file copied from Linux'
const UNSAFE_REMOVED = 'removed an unsafe or unreadable sign-in file'
const DEAD_ENCRYPTED = 'removed an unreadable encrypted sign-in; no keyring is running'

const encryptedFor = (userId: string, refreshToken: string) =>
  fakeSeal(JSON.stringify({ v: 1, userId, refreshToken }))

const fsError = (code?: string) =>
  Object.assign(new Error(`fake ${code ?? 'failure'}`), code ? { code } : {})

/** Every rmSync of a named file throws, with that code (or none); the rest pass through. */
function failRm(failures: Record<string, string | undefined>): void {
  vi.mocked(rmSync).mockImplementation((path, options) => {
    const name = basename(String(path))
    if (name in failures) throw fsError(failures[name])
    real.rmSync(path, options)
  })
}

/** What `act` throws or rejects with. */
async function thrown(act: () => unknown): Promise<unknown> {
  try {
    await act()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

/** The message of a VaultUnreadable, failing on any other error. */
async function refusal(act: () => unknown): Promise<string> {
  const error = await thrown(act)
  expect(error).toBeInstanceOf(VaultUnreadable)
  return (error as VaultUnreadable).message
}

function linux(
  storage: Storage = { ok: true, kind: 'file' },
  uid: () => number | undefined = () => owner,
) {
  const fake = fakeCipher(storage)
  const log = vi.fn()
  return { vault: createVault(dir, fake.cipher, 'linux', log, uid), log, ...fake }
}

function seed(files: Record<string, string | Buffer>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, data] of Object.entries(files)) writeFileSync(file(name), data, { mode: 0o600 })
  clearFs()
}

const PROFILE = JSON.stringify({ v: 1, user: USER })

function seedPlain(content: string | Buffer, mode = 0o600): void {
  seed({ 'profile.json': PROFILE, 'session.txt': content })
  chmodSync(file('session.txt'), mode)
  clearFs()
}

function reset(): void {
  real.rmSync(dir, { recursive: true, force: true })
  clearFs()
}

/** The order of writes, renames and removals, with random temp suffixes masked. */
function fileEvents(): string[] {
  const events: [number, string][] = []
  const masked = (path: unknown) => basename(String(path)).replace(/\.[0-9a-f]{12}\.tmp$/, '.tmp')
  vi.mocked(writeFileSync).mock.calls.forEach(([path], i) =>
    events.push([vi.mocked(writeFileSync).mock.invocationCallOrder[i]!, `write ${masked(path)}`]),
  )
  vi.mocked(renameSync).mock.calls.forEach(([from, to], i) =>
    events.push([
      vi.mocked(renameSync).mock.invocationCallOrder[i]!,
      `rename ${masked(from)} ${masked(to)}`,
    ]),
  )
  vi.mocked(rmSync).mock.calls.forEach(([path], i) =>
    events.push([vi.mocked(rmSync).mock.invocationCallOrder[i]!, `rm ${masked(path)}`]),
  )
  return events.sort(([a], [b]) => a - b).map(([, event]) => event)
}

describe.skipIf(process.platform === 'win32')('Linux-only plain fallback', () => {
  it('writes a plain token only on Linux; elsewhere a file cipher saves nothing and clears', async () => {
    for (const platform of ['darwin', 'win32', 'freebsd', 'android'] as const) {
      seed({ 'session.bin': 'x', 'session.txt': 'x', 'profile.json': 'x', 'avatar.json': 'x' })
      const log = vi.fn()
      const { cipher } = fakeCipher({ ok: true, kind: 'file' })
      expect(await createVault(dir, cipher, platform, log).save(USER, token())).toBe(false)
      expect(listed()).toEqual([])
      expect(writeFileSync).not.toHaveBeenCalled()
      expect(log.mock.calls).toEqual([[LINUX_PLAIN]])
    }
    reset()
    const secret = token()
    expect(await linux().vault.save(USER, secret)).toBe(true)
    expect(listed()).toEqual(['profile.json', 'session.txt'])
    expect(readFileSync(file('session.txt'), 'utf8')).toBe(secret)
  })

  it('off Linux, removes a copied plain token on savedMode, readToken and save only', async () => {
    const { cipher } = fakeCipher()
    const storage = vi.spyOn(cipher, 'storage')
    const log = vi.fn()
    const vault = createVault(dir, cipher, 'darwin', log)
    const copy = () => seed({ 'session.txt': token() })
    copy()
    expect(vault.savedMode()).toBeNull()
    expect(listed()).toEqual([])
    copy()
    expect(await refusal(() => vault.readToken(USER.id))).toBe('the saved sign-in is missing')
    expect(listed()).toEqual([])
    expect(storage).not.toHaveBeenCalled()
    copy()
    expect(vault.readProfile()).toBeNull()
    expect(listed()).toEqual(['session.txt'])
    expect(log.mock.calls).toEqual([[LINUX_PLAIN], [LINUX_PLAIN]])
    expect(await vault.save(USER, token())).toBe(true)
    expect(listed()).toEqual(['profile.json', 'session.bin'])
    expect(log.mock.calls).toEqual([[LINUX_PLAIN], [LINUX_PLAIN], [LINUX_PLAIN]])
    copy()
    vault.clear()
    expect(listed()).toEqual([])
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('on Linux, savedMode prefers a plain file by lstat alone, never asking the cipher', async () => {
    const { vault, cipher } = linux({ ok: true, kind: 'gnome_libsecret' })
    const storage = vi.spyOn(cipher, 'storage')
    const decrypt = vi.spyOn(cipher, 'decrypt')
    expect(vault.savedMode()).toBeNull()
    seed({ 'session.bin': encryptedFor(USER.id, token()) })
    expect(vault.savedMode()).toBe('keyring')
    symlinkSync(join(root, 'nowhere'), file('session.txt'))
    expect(vault.savedMode()).toBe('file')
    expect(storage).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(openSync).not.toHaveBeenCalled()
  })

  it('reports unavailable storage before opening the plain token or decrypting the other', async () => {
    seedPlain(token())
    writeFileSync(file('session.bin'), encryptedFor(USER.id, token()))
    clearFs()
    const { vault, state } = linux({ ok: false, reason: 'the system keyring is unavailable' })
    expect(await refusal(() => vault.readToken(USER.id))).toBe('the system keyring is unavailable')
    expect(listed()).toEqual(['profile.json', 'session.bin', 'session.txt'])
    expect(openSync).not.toHaveBeenCalled()
    // The encrypted bytes are read before the storage check, so a sign-out can
    // delete the files straight after asking; they are never decrypted here.
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => path)).toEqual([file('session.bin')])
    expect(state.decrypts).toBe(0)
    expect(rmSync).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('plain token descriptor checks', () => {
  it('opens once, read-only, no-follow and non-blocking, and reads only that descriptor', async () => {
    const secret = token()
    seedPlain(secret)
    expect(await linux().vault.readToken(USER.id)).toBe(secret)
    expect(vi.mocked(openSync).mock.calls).toEqual([
      [file('session.txt'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK],
    ])
    const fd = vi.mocked(openSync).mock.results[0]?.value
    expect(typeof fd).toBe('number')
    expect(vi.mocked(fstatSync).mock.calls).toEqual([[fd]])
    expect(readSync).toHaveBeenCalled()
    expect(vi.mocked(readSync).mock.calls.every(([used]) => used === fd)).toBe(true)
    expect(vi.mocked(closeSync).mock.calls).toEqual([[fd]])
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => path)).toEqual([file('profile.json')])
  })

  it.each([0o600, 0o400, 0o700])(
    'accepts a plain token only its owner can reach (%o)',
    async (mode) => {
      const secret = token()
      seedPlain(secret, mode)
      expect(await linux().vault.readToken(USER.id)).toBe(secret)
    },
  )

  it.each([0o640, 0o604, 0o660, 0o620, 0o602, 0o610, 0o601])(
    'refuses any group or other bit (%o) before reading, and removes the file',
    async (mode) => {
      seedPlain(token(), mode)
      const { vault, log } = linux()
      expect(await refusal(() => vault.readToken(USER.id))).toBe(
        'the saved sign-in file could not be read',
      )
      expect(readSync).not.toHaveBeenCalled()
      expect(closeSync).toHaveBeenCalledOnce()
      expect(listed()).toEqual(['profile.json'])
      expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
    },
  )

  it('refuses an unknown or different owner before reading', async () => {
    for (const uid of [() => undefined, () => (owner ?? 0) + 1]) {
      seedPlain(token())
      const { vault, log } = linux({ ok: true, kind: 'file' }, uid)
      expect(await refusal(() => vault.readToken(USER.id))).toBe(
        'the saved sign-in file could not be read',
      )
      expect(fstatSync).toHaveBeenCalledOnce()
      expect(readSync).not.toHaveBeenCalled()
      expect(listed()).toEqual(['profile.json'])
      expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
    }
  })

  it('refuses a link without following it, and a directory, removing either', async () => {
    const secret = token()
    seedPlain(secret)
    real.rmSync(file('session.txt'))
    writeFileSync(join(root, 'target'), secret, { mode: 0o600 })
    symlinkSync(join(root, 'target'), file('session.txt'))
    clearFs()
    let { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the saved sign-in file could not be read',
    )
    expect(fstatSync).not.toHaveBeenCalled()
    expect(readSync).not.toHaveBeenCalled()
    expect(listed()).toEqual(['profile.json'])
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe(secret)
    expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])

    mkdirSync(file('session.txt'))
    clearFs()
    ;({ vault, log } = linux())
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the saved sign-in file could not be read',
    )
    expect(readSync).not.toHaveBeenCalled()
    expect(vi.mocked(rmdirSync).mock.calls).toEqual([[file('session.txt')]])
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('accepts exactly 4096 bytes and refuses one more before reading', async () => {
    const boundary = 'a'.repeat(4096)
    seedPlain(boundary)
    expect(await linux().vault.readToken(USER.id)).toBe(boundary)
    reset()
    seedPlain('a'.repeat(4097))
    const { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the saved sign-in file could not be read',
    )
    expect(readSync).not.toHaveBeenCalled()
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
  })

  it('reads at most 4097 bytes from a descriptor that grew after fstat, and refuses it', async () => {
    seedPlain('a'.repeat(5000))
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const stat = real.fstatSync(fd)
      stat.size = 1
      return stat
    })
    const { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the saved sign-in file could not be read',
    )
    const yielded = vi.mocked(readSync).mock.results.map(({ value }) => value as number)
    expect(yielded.reduce((sum, count) => sum + count, 0)).toBe(4097)
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
  })

  it('measures the decoded token: 4096 bytes that are not UTF-8 are refused', async () => {
    seedPlain(Buffer.alloc(4096, 0xff))
    const { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the saved sign-in file could not be read',
    )
    expect(readSync).toHaveBeenCalled()
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
  })

  it('binds the plain token to the saved profile, after reading it', async () => {
    const profiles = [null, '{', JSON.stringify({ v: 1, user: { ...USER, id: 'someone-else' } })]
    for (const profile of profiles) {
      seedPlain(token())
      if (profile === null) real.rmSync(file('profile.json'))
      else real.writeFileSync(file('profile.json'), profile)
      const { vault, log } = linux()
      expect(await refusal(() => vault.readToken(USER.id))).toBe(
        'the saved sign-in file could not be read',
      )
      expect(readSync).toHaveBeenCalled()
      expect(readdirSync(dir)).not.toContain('session.txt')
      expect(log.mock.calls).toEqual([[UNSAFE_REMOVED]])
      reset()
    }
    seedPlain(token())
    const { vault } = linux()
    expect(await refusal(() => vault.readToken('someone-else'))).toBe(
      'the saved sign-in file could not be read',
    )
    expect(listed()).toEqual(['profile.json'])
  })
})

describe.skipIf(process.platform === 'win32')('encrypted preference and no downgrade', () => {
  it('on Linux, a readable encrypted token wins over a plain one, which is removed', async () => {
    for (const kind of ['gnome_libsecret', 'file']) {
      const secret = token()
      seedPlain(token())
      seed({ 'session.bin': encryptedFor(USER.id, secret) })
      const { vault, state, log } = linux({ ok: true, kind })
      expect(await vault.readToken(USER.id)).toBe(secret)
      expect(listed()).toEqual(['profile.json', 'session.bin'])
      expect(state.decrypts).toBe(1)
      expect(openSync).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
      reset()
    }
  })

  it('with a keyring, an unreadable, foreign or damaged encrypted token is an error', async () => {
    const cases = [
      [Buffer.from('junk'), 'the saved sign-in could not be decrypted'],
      [encryptedFor('someone-else', token()), 'the saved sign-in belongs to someone else'],
      [encryptedFor(USER.id, ''), 'the saved sign-in is damaged'],
    ] as const
    for (const [encrypted, message] of cases) {
      seedPlain(token())
      seed({ 'session.bin': encrypted })
      const { vault, log } = linux({ ok: true, kind: 'kwallet6' })
      expect(await refusal(() => vault.readToken(USER.id))).toBe(message)
      expect(listed()).toEqual(['profile.json', 'session.bin', 'session.txt'])
      expect(openSync).not.toHaveBeenCalled()
      expect(rmSync).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
      reset()
    }
  })

  it('without a keyring, a dead or foreign encrypted token is removed and the plain one read', async () => {
    const dead = [
      Buffer.from('junk'),
      encryptedFor('someone-else', token()),
      encryptedFor(USER.id, ''),
    ]
    for (const encrypted of dead) {
      const plain = token()
      seedPlain(plain)
      seed({ 'session.bin': encrypted })
      const { vault, log } = linux()
      expect(await vault.readToken(USER.id)).toBe(plain)
      expect(listed()).toEqual(['profile.json', 'session.txt'])
      expect(log.mock.calls).toEqual([[DEAD_ENCRYPTED]])
      reset()
    }
    seed({ 'profile.json': PROFILE, 'session.bin': 'junk' })
    const { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe('the saved sign-in is missing')
    expect(listed()).toEqual(['profile.json'])
    expect(log.mock.calls).toEqual([[DEAD_ENCRYPTED]])
  })

  it('refuses to replace a readable encrypted token with a plain file, changing nothing', async () => {
    const encrypted = encryptedFor(USER.id, token())
    seed({ 'profile.json': PROFILE, 'session.bin': encrypted })
    const { vault, log } = linux()
    expect(await refusal(() => vault.save(USER, token()))).toBe(
      'refused to replace a readable encrypted sign-in with a file',
    )
    expect(listed()).toEqual(['profile.json', 'session.bin'])
    expect(readFileSync(file('session.bin'))).toEqual(encrypted)
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(rmSync).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('replaces a foreign or dead encrypted token with the plain file, saying so', async () => {
    for (const encrypted of [encryptedFor('someone-else', token()), Buffer.from('junk')]) {
      seed({ 'session.bin': encrypted })
      const secret = token()
      const { vault, log } = linux()
      expect(await vault.save(USER, secret)).toBe(true)
      expect(listed()).toEqual(['profile.json', 'session.txt'])
      expect(readFileSync(file('session.txt'), 'utf8')).toBe(secret)
      expect(log.mock.calls).toEqual([[DEAD_ENCRYPTED]])
      reset()
    }
  })

  it('checks the plain token size, in UTF-8 bytes, before any file changes', async () => {
    seed({ 'profile.json': PROFILE, 'session.bin': encryptedFor(USER.id, token()) })
    const { vault } = linux()
    for (const bad of ['', 'é'.repeat(2049)]) {
      expect(await refusal(() => vault.save(USER, bad))).toBe(
        'the sign-in token is too large or empty',
      )
      expect(writeFileSync).not.toHaveBeenCalled()
      expect(rmSync).not.toHaveBeenCalled()
    }
    real.rmSync(file('session.bin'))
    const boundary = 'é'.repeat(2048)
    expect(await vault.save(USER, boundary)).toBe(true)
    expect(await vault.readToken(USER.id)).toBe(boundary)
  })

  it('writes the credential before the profile, and drops the other credential between', async () => {
    seedPlain(token())
    await linux({ ok: true, kind: 'gnome_libsecret' }).vault.save(USER, token())
    expect(fileEvents()).toEqual([
      'write session.bin.tmp',
      'rename session.bin.tmp session.bin',
      'rm session.txt',
      'write profile.json.tmp',
      'rename profile.json.tmp profile.json',
    ])
    expect(vi.mocked(writeFileSync).mock.calls.map(([, , options]) => options)).toEqual([
      { mode: 0o600, flag: 'wx' },
      { mode: 0o600, flag: 'wx' },
    ])
    expect(vi.mocked(mkdirSync).mock.calls).toEqual([
      [dir, { recursive: true, mode: 0o700 }],
      [dir, { recursive: true, mode: 0o700 }],
    ])
    expect(vi.mocked(chmodSync).mock.calls).toEqual([
      [dir, 0o700],
      [dir, 0o700],
    ])
    reset()
    seed({ 'session.bin': 'junk' })
    await linux().vault.save(USER, token())
    expect(fileEvents()).toEqual([
      'rm session.bin',
      'write session.txt.tmp',
      'rename session.txt.tmp session.txt',
      'write profile.json.tmp',
      'rename profile.json.tmp profile.json',
    ])
  })
})

describe.skipIf(process.platform === 'win32')('cleanup errors and credential-first clear', () => {
  const everything = {
    'session.bin': 'x',
    'session.txt': 'x',
    'profile.json': 'x',
    'avatar.json': 'x',
  }

  it('clears the credentials first, then the profile and the avatar, forcing each', async () => {
    seed(everything)
    linux().vault.clear()
    expect(vi.mocked(rmSync).mock.calls).toEqual(
      ['session.bin', 'session.txt', 'profile.json', 'avatar.json'].map((name) => [
        file(name),
        { force: true },
      ]),
    )
    expect(listed()).toEqual([])
  })

  it('tries every file and reports each that would not go, by code', async () => {
    seed(everything)
    failRm({ 'session.bin': 'EACCES', 'profile.json': undefined })
    const error = await thrown(() => linux().vault.clear())
    expect(error).not.toBeInstanceOf(VaultUnreadable)
    expect((error as Error).message).toBe(
      'could not delete session.bin (EACCES) and profile.json (error)',
    )
    expect(rmSync).toHaveBeenCalledTimes(4)
    expect(listed()).toEqual(['profile.json', 'session.bin'])
  })

  it('a save without storage clears, and throws when the clear fails', async () => {
    seed(everything)
    failRm({ 'session.txt': 'EPERM' })
    const { vault } = linux({ ok: false, reason: 'no keyring' })
    expect(((await thrown(() => vault.save(USER, token()))) as Error).message).toBe(
      'could not delete session.txt (EPERM)',
    )
    expect(listed()).toEqual(['session.txt'])
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('a failed write removes its temp file, keeps the old credential and writes no profile', async () => {
    const old = token()
    for (const fail of ['rename', 'write'] as const) {
      seedPlain(old)
      const target = fail === 'rename' ? vi.mocked(renameSync) : vi.mocked(writeFileSync)
      target.mockImplementationOnce(() => {
        throw fsError('EXDEV')
      })
      const { vault } = linux({ ok: true, kind: 'gnome_libsecret' })
      expect(await thrown(() => vault.save({ ...USER, name: 'New' }, token()))).toMatchObject({
        code: 'EXDEV',
      })
      expect(listed()).toEqual(['profile.json', 'session.txt'])
      expect(readFileSync(file('session.txt'), 'utf8')).toBe(old)
      expect(vault.readProfile()).toEqual(USER)
      const temp = vi.mocked(writeFileSync).mock.calls[0]?.[0]
      expect(vi.mocked(rmSync).mock.calls).toEqual([[temp, { force: true }]])
      reset()
    }
  })

  it('reports a refused plain file that will not go, and still closes its descriptor', async () => {
    seedPlain(token(), 0o644)
    failRm({ 'session.txt': 'EBUSY' })
    const { vault, log } = linux()
    expect(await refusal(() => vault.readToken(USER.id))).toBe(
      'the unsafe sign-in file could not be removed',
    )
    expect(vi.mocked(rmdirSync).mock.calls).toEqual([[file('session.txt')]])
    expect(log.mock.calls).toEqual([['could not remove an unsafe sign-in file']])
    expect(closeSync).toHaveBeenCalledOnce()
    expect(listed()).toEqual(['profile.json', 'session.txt'])
  })

  it('surfaces the file error when cleanup beside an encrypted token fails', async () => {
    seedPlain(token())
    seed({ 'session.bin': encryptedFor(USER.id, token()) })
    failRm({ 'session.txt': 'EBUSY' })
    expect(await thrown(() => linux().vault.readToken(USER.id))).toMatchObject({ code: 'EBUSY' })
    expect(listed()).toEqual(['profile.json', 'session.bin', 'session.txt'])
    reset()

    seedPlain(token())
    seed({ 'session.bin': 'junk' })
    failRm({ 'session.bin': 'EACCES' })
    let { vault, log } = linux()
    expect(await thrown(() => vault.readToken(USER.id))).toMatchObject({ code: 'EACCES' })
    expect(openSync).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    reset()

    seed({ 'session.bin': 'junk' })
    failRm({ 'session.bin': 'EACCES' })
    ;({ vault, log } = linux())
    expect(await thrown(() => vault.save(USER, token()))).toMatchObject({ code: 'EACCES' })
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(listed()).toEqual(['session.bin'])
  })
})
