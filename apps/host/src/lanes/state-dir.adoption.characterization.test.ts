import * as fs from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareStateDirectory, prepareStateFile, StateFailure } from './state-dir'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return {
    ...original,
    lstatSync: vi.fn(original.lstatSync),
    fstatSync: vi.fn(original.fstatSync),
    mkdirSync: vi.fn(original.mkdirSync),
  }
})

let root: string
let directory: string
const uid = process.getuid!()
const details = {
  directory: 'Unsafe storage. Use an owned directory, no symlink, chmod 700.',
  file: 'Unsafe state.sqlite. Use an owned regular file, no symlink, chmod 600.',
  sidecar: 'Unsafe SQLite sidecar. Use owned regular files, no symlinks, chmod 600.',
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'host-state-adoption-'))
  directory = join(root, 'state')
  fs.mkdirSync(directory, { mode: 0o700 })
})
afterEach(() => {
  vi.resetAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function expectFailure(call: () => unknown, detail: string): void {
  let thrown: unknown
  try {
    call()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(StateFailure)
  expect(thrown).toMatchObject({
    directory,
    exitCode: 78,
    message: `Host state in ${directory}: ${detail}`,
  })
}

function stateFile(): string {
  const path = join(directory, 'state.sqlite')
  fs.writeFileSync(path, 'unchanged', { mode: 0o600 })
  return path
}

describe('private state directory adoption', () => {
  it.each([undefined, uid + 1])('refuses directory ownership for uid %s', (owner) => {
    expectFailure(() => prepareStateDirectory(directory, owner), details.directory)
  })

  it.each([0o040, 0o020, 0o010, 0o004, 0o002, 0o001])(
    'refuses directory group/other bit %i without chmod',
    (bit) => {
      fs.chmodSync(directory, 0o700 | bit)
      expectFailure(() => prepareStateDirectory(directory, uid), details.directory)
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700 | bit)
    },
  )

  it.each([0o000, 0o100, 0o200, 0o300, 0o400, 0o500, 0o600, 0o700])(
    'accepts existing directory owner-bit subset %i unchanged',
    (mode) => {
      fs.chmodSync(directory, mode)
      try {
        expect(prepareStateDirectory(directory, uid)).toBeUndefined()
        expect(fs.lstatSync(directory).mode & 0o777).toBe(mode)
      } finally {
        fs.chmodSync(directory, 0o700)
      }
    },
  )

  it('refuses a directory symlink and a non-directory', () => {
    const target = join(root, 'target')
    fs.renameSync(directory, target)
    fs.symlinkSync(target, directory)
    expectFailure(() => prepareStateDirectory(directory, uid), details.directory)
    fs.unlinkSync(directory)
    fs.writeFileSync(directory, '')
    expectFailure(() => prepareStateDirectory(directory, uid), details.directory)
  })

  it.each(['EEXIST', 'ENOTDIR', 'ELOOP'])(
    'wraps a creation Error with %s as the same StateFailure',
    (code) => {
      fs.rmdirSync(directory)
      const fail = () => {
        throw Object.assign(new Error('creation failed'), { code })
      }
      if (code === 'EEXIST') vi.mocked(fs.lstatSync).mockImplementationOnce(fail)
      else vi.mocked(fs.mkdirSync).mockImplementationOnce(fail)
      expectFailure(() => prepareStateDirectory(directory, uid), details.directory)
    },
  )

  it.each([Object.assign(new Error('denied'), { code: 'EACCES' }), { code: 'ENOENT' }])(
    'preserves unexpected or non-Error stat failure %j',
    (error) => {
      vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
        throw error
      })
      expect(() => prepareStateDirectory(directory, uid)).toThrow(error)
    },
  )
})

describe('private state file adoption', () => {
  it('creates and chmods a new file to 0600 under umask 0', () => {
    const previous = process.umask(0)
    try {
      const path = prepareStateFile(directory, uid)
      expect(path).toBe(join(directory, 'state.sqlite'))
      expect(fs.lstatSync(path).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
    }
  })

  it.each([undefined, uid + 1])('refuses existing file ownership for uid %s', (owner) => {
    const path = stateFile()
    expectFailure(() => prepareStateFile(directory, owner), details.file)
    expect(fs.readFileSync(path, 'utf8')).toBe('unchanged')
  })

  it('checks the opened descriptor owner even for a newly created file', () => {
    expectFailure(() => prepareStateFile(directory, undefined), details.file)
  })

  it.each([0o040, 0o020, 0o010, 0o004, 0o002, 0o001])('refuses file group/other bit %i', (bit) => {
    const path = stateFile()
    fs.chmodSync(path, 0o600 | bit)
    expectFailure(() => prepareStateFile(directory, uid), details.file)
    expect(fs.lstatSync(path).mode & 0o777).toBe(0o600 | bit)
  })

  it.each([0o000, 0o100, 0o200, 0o300, 0o400, 0o500, 0o600, 0o700])(
    'accepts file owner-bit subset %i in both stat checks',
    (mode) => {
      const path = stateFile()
      // Keep the real file openable; report each subset at the two safety checks.
      const info = fs.lstatSync(path)
      const reportedMode = (info.mode & ~0o777) | mode
      vi.mocked(fs.lstatSync).mockReturnValueOnce(Object.assign(info, { mode: reportedMode }))
      vi.mocked(fs.fstatSync).mockReturnValueOnce(
        Object.assign(fs.statSync(path), { mode: reportedMode }),
      )
      expect(prepareStateFile(directory, uid)).toBe(path)
      expect(fs.lstatSync(path).mode & 0o777).toBe(0o600)
    },
  )

  it.each(['owner', 'permissions', 'type'])(
    'refuses an unsafe opened descriptor %s after a safe lstat',
    (field) => {
      const path = stateFile()
      const info = fs.statSync(path)
      if (field === 'owner') info.uid = uid + 1
      if (field === 'permissions') info.mode |= 0o004
      if (field === 'type') info.isFile = () => false
      vi.mocked(fs.fstatSync).mockReturnValueOnce(info)
      expectFailure(() => prepareStateFile(directory, uid), details.file)
    },
  )

  it.each(['symlink', 'directory'])('refuses a state file that is a %s', (kind) => {
    const path = join(directory, 'state.sqlite')
    if (kind === 'directory') fs.mkdirSync(path)
    else fs.symlinkSync(stateTarget(), path)
    expectFailure(() => prepareStateFile(directory, uid), details.file)
  })
})

function stateTarget(): string {
  const target = join(root, 'target')
  fs.writeFileSync(target, 'untouched', { mode: 0o600 })
  return target
}

describe.each(['-wal', '-shm'])('SQLite %s sidecar adoption', (suffix) => {
  it.each(['owner', 'permissions', 'symlink', 'directory'])(
    'refuses an unsafe sidecar %s with the same StateFailure',
    (kind) => {
      const path = stateFile() + suffix
      const target = stateTarget()
      if (kind === 'symlink') fs.symlinkSync(target, path)
      else if (kind === 'directory') fs.mkdirSync(path)
      else {
        fs.writeFileSync(path, '', { mode: kind === 'permissions' ? 0o644 : 0o600 })
        if (kind === 'owner') {
          const state = fs.lstatSync(join(directory, 'state.sqlite'))
          const sidecar = fs.lstatSync(path)
          const lstat = vi.mocked(fs.lstatSync).mockReturnValueOnce(state)
          if (suffix === '-shm') {
            fs.writeFileSync(path.replace(/-shm$/, '-wal'), '', { mode: 0o600 })
            lstat.mockReturnValueOnce(state)
          }
          lstat.mockReturnValueOnce(Object.assign(sidecar, { uid: uid + 1 }))
        }
      }
      expectFailure(() => prepareStateFile(directory, uid), details.sidecar)
      expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
    },
  )

  it('accepts a private sidecar with owner-bit subsets unchanged', () => {
    const path = stateFile()
    fs.writeFileSync(path + suffix, '', { mode: 0o400 })
    expect(prepareStateFile(directory, uid)).toBe(path)
    expect(fs.lstatSync(path + suffix).mode & 0o777).toBe(0o400)
  })

  it('propagates sidecar read errors other than ENOENT', () => {
    const path = stateFile()
    const info = fs.lstatSync(path)
    const error = Object.assign(new Error('denied'), { code: 'EACCES' })
    vi.mocked(fs.lstatSync)
      .mockReturnValueOnce(info)
      .mockImplementationOnce(() => {
        throw error
      })
    expect(() => prepareStateFile(directory, uid)).toThrow(error)
  })
})
