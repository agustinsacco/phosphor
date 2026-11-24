import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installLockPaths,
  refuseInstallLock,
  removeRetiredLock,
  renameToRetired,
  retireInstallLock,
  retiredLockPid,
  sweepRetiredLocks,
} from './lock-retirement'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-lock-retirement-')))
  homes.push(home)
  const lib = join(home, 'lib')
  mkdirSync(lib)
  return { home, lib, paths: installLockPaths(lib, 77) }
}
function folder(path: string, contents: { pid?: boolean; gate?: boolean } = {}): string {
  mkdirSync(path)
  if (contents.pid !== false) writeFileSync(join(path, 'pid'), '1\n')
  if (contents.gate !== false) mkdirSync(join(path, 'recovery'))
  return path
}
const refusal = (lib: string) =>
  `Install lock: ${join(lib, '.install-lock')}. Remove it only if no install or update is running.`
function caught(action: () => void): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected the action to throw')
}
const code = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined

describe('installLockPaths and refuseInstallLock', () => {
  it('names the lock and the retired name of a pid, defaulting to this process', () => {
    expect(installLockPaths('/lib', 77)).toEqual({
      lib: '/lib',
      lock: '/lib/.install-lock',
      retired: '/lib/.install-lock.retired.77',
    })
    expect(installLockPaths('/lib').retired).toBe(`/lib/.install-lock.retired.${process.pid}`)
  })
  it('refuses with the lock path and no errno code', () => {
    const paths = installLockPaths('/lib', 77)
    expect(() => refuseInstallLock(paths)).toThrow(new Error(refusal('/lib')))
    expect(code(caught(() => refuseInstallLock(paths)))).toBeUndefined()
  })
})

describe('retiredLockPid', () => {
  it.each([
    ['.install-lock.retired.1', 1],
    ['.install-lock.retired.77', 77],
    ['.install-lock.retired.9999999999', 9999999999],
  ])('reads %s as pid %d', (name, pid) => {
    expect(retiredLockPid(name)).toBe(pid)
  })
  it.each([
    '.install-lock',
    '.install-lock.retired.',
    '.install-lock.retired.0',
    '.install-lock.retired.01',
    '.install-lock.retired.-5',
    '.install-lock.retired.5x',
    '.install-lock.retired.12.bak',
    '.install-lock.retired.12345678901',
    '.install-lock.retired.1\n',
    'x.install-lock.retired.5',
  ])('rejects the lookalike %j', (name) => {
    expect(retiredLockPid(name)).toBeUndefined()
  })
})

describe('removeRetiredLock', () => {
  it('removes the known contents and the folder, its own retired name by default', () => {
    const { lib, paths } = setup()
    folder(paths.retired)
    removeRetiredLock(paths)
    folder(join(lib, '.install-lock.retired.5'), { pid: false, gate: false })
    removeRetiredLock(paths, join(lib, '.install-lock.retired.5'))
    expect(readdirSync(lib)).toEqual([])
  })
  it.each([
    ['an unknown file', 'ENOTEMPTY', ['extra']],
    ['a non-empty gate', 'ENOTEMPTY', ['recovery']],
    ['a gate file', 'ENOTDIR', ['recovery']],
    ['a pid folder', process.platform === 'darwin' ? 'EPERM' : 'EISDIR', ['pid']],
  ])('fails on %s, keeping the folder', (kind, failure, left) => {
    const { paths } = setup()
    const path = folder(paths.retired, { gate: kind === 'an unknown file' })
    if (kind === 'an unknown file') writeFileSync(join(path, 'extra'), '')
    if (kind === 'a non-empty gate') mkdirSync(join(path, 'recovery', 'inner'), { recursive: true })
    if (kind === 'a gate file') writeFileSync(join(path, 'recovery'), '')
    if (kind === 'a pid folder') {
      rmSync(join(path, 'pid'))
      mkdirSync(join(path, 'pid'))
    }
    expect(code(caught(() => removeRetiredLock(paths)))).toBe(failure)
    expect(readdirSync(path)).toEqual(left)
  })
  it('refuses a linked gate without following it', () => {
    const { home, lib, paths } = setup()
    const path = folder(paths.retired, { gate: false })
    mkdirSync(join(home, 'gate'))
    writeFileSync(join(home, 'gate', 'keep'), '')
    symlinkSync(join(home, 'gate'), join(path, 'recovery'))
    expect(() => removeRetiredLock(paths)).toThrow(new Error(refusal(lib)))
    expect(lstatSync(join(path, 'recovery')).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(home, 'gate'))).toEqual(['keep'])
  })
})

describe('renameToRetired and retireInstallLock', () => {
  it('retires a lock by rename, then removes the retired folder', () => {
    const { lib, paths } = setup()
    folder(paths.lock)
    renameToRetired(paths)
    expect(readdirSync(lib)).toEqual(['.install-lock.retired.77'])
    expect(readdirSync(paths.retired).sort()).toEqual(['pid', 'recovery'])
    rmSync(paths.retired, { recursive: true })
    folder(paths.lock)
    retireInstallLock(paths)
    expect(readdirSync(lib)).toEqual([])
  })
  it.each(['file', 'folder', 'link'])('refuses a retired name held by a %s', (kind) => {
    const { home, lib, paths } = setup()
    folder(paths.lock)
    mkdirSync(join(home, 'target'))
    if (kind === 'file') writeFileSync(paths.retired, '')
    if (kind === 'folder') mkdirSync(paths.retired)
    if (kind === 'link') symlinkSync(join(home, 'target'), paths.retired)
    expect(() => retireInstallLock(paths)).toThrow(new Error(refusal(lib)))
    expect(readdirSync(paths.lock).sort()).toEqual(['pid', 'recovery'])
    expect(lstatSync(paths.retired).isSymbolicLink()).toBe(kind === 'link')
  })
  it('lets a missing lock fail the rename', () => {
    const { paths } = setup()
    expect(code(caught(() => renameToRetired(paths)))).toBe('ENOENT')
  })
})

describe('sweepRetiredLocks', () => {
  it('asks about the first 16 exact folders and removes only the dead', () => {
    const { lib, paths } = setup()
    for (let i = 1; i <= 18; i++) folder(join(lib, `.install-lock.retired.${100 + i}`))
    const asked: number[] = []
    sweepRetiredLocks(paths, (pid) => {
      asked.push(pid)
      return pid % 2 === 0
    })
    expect(asked).toHaveLength(16)
    const left = readdirSync(lib).map((name) => retiredLockPid(name) ?? 0)
    expect(left.filter((pid) => asked.includes(pid)).every((pid) => pid % 2 === 1)).toBe(true)
    expect(left).toHaveLength(18 - asked.filter((pid) => pid % 2 === 0).length)
  })
  it('passes over lookalikes, files and links without counting or asking', () => {
    const { home, lib, paths } = setup()
    mkdirSync(join(home, 'target'))
    mkdirSync(join(lib, '.install-lock.retired.01'))
    writeFileSync(join(lib, '.install-lock.retired.5'), '')
    symlinkSync(join(home, 'target'), join(lib, '.install-lock.retired.6'))
    folder(paths.lock)
    for (let i = 1; i <= 16; i++) folder(join(lib, `.install-lock.retired.${200 + i}`))
    const asked: number[] = []
    sweepRetiredLocks(paths, (pid) => {
      asked.push(pid)
      return true
    })
    expect(asked.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => 201 + i))
    expect(readdirSync(lib).sort()).toEqual([
      '.install-lock',
      '.install-lock.retired.01',
      '.install-lock.retired.5',
      '.install-lock.retired.6',
    ])
    expect(existsSync(join(home, 'target'))).toBe(true)
  })
  it('stops at the first cleanup failure and lets a port failure escape', () => {
    const { lib, paths } = setup()
    const path = folder(join(lib, '.install-lock.retired.300'))
    writeFileSync(join(path, 'extra'), '')
    expect(code(caught(() => sweepRetiredLocks(paths, () => true)))).toBe('ENOTEMPTY')
    const failed = new Error('port failed')
    expect(() =>
      sweepRetiredLocks(paths, () => {
        throw failed
      }),
    ).toThrow(failed)
    expect(readdirSync(path)).toEqual(['extra'])
  })
})
