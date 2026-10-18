import * as fs from 'node:fs'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { buildPiEnvironment } from './environment'
import { resolvePi, which } from './executables'
import { launchdExit, prepareLaunchdRun, readServiceExit, serviceExitPath } from './launchd'
import { hostLogDirectory } from './log'
import { HOST_PATH_BLOCK, installHostPath, removeHostPathBlocks } from './shell-path'
import { removeServiceUnit, writeServiceUnit } from './systemd'

vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })
const actualFs = await vi.importActual<typeof fs>('node:fs')
const actualPromises = await vi.importActual<typeof promises>('node:fs/promises')

const ownUid = process.getuid?.() ?? -1
const SECRET = '/Users/someone/secret-path'
/** An Error carrying `code`, as node:fs throws one. */
const failure = (code: unknown, message = `${String(code)}: raw ${SECRET}`) =>
  Object.assign(new Error(message), { code })
/** A thrown value that is not an Error but carries the same code. */
const plain = (code: string) => ({ code, message: `${code}: plain` })
function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

let root: string
let machine: FakeMachine | undefined
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'host-fs-errors-'))
})
afterEach(() => {
  vi.resetAllMocks()
  machine?.cleanup()
  machine = undefined
  rmSync(root, { recursive: true, force: true })
})

function recorder() {
  const entries: { message: string; data: unknown }[] = []
  return {
    entries,
    log: (_scope: string, message: string, data?: unknown) => entries.push({ message, data }),
  }
}

describe('launchd optional files (characterization)', () => {
  it('readServiceExit ignores only a missing record or unreadable JSON', async () => {
    const path = join(root, 'service-exit.json')
    expect(await readServiceExit(path)).toBeUndefined()
    writeFileSync(path, '{')
    expect(await readServiceExit(path)).toBeUndefined()
    vi.mocked(promises.open).mockRejectedValueOnce(failure('ENOENT'))
    expect(await readServiceExit(path)).toBeUndefined()
    for (const error of [
      failure('EACCES'),
      failure('EPERM'),
      failure('ELOOP'),
      failure('EIO'),
      plain('ENOENT'),
    ]) {
      vi.mocked(promises.open).mockRejectedValueOnce(error)
      await expect(readServiceExit(path)).rejects.toBe(error)
    }
  })

  it('prepareLaunchdRun is silent about a missing exit record or err log and logs every other failure', () => {
    const missingOnly = recorder()
    prepareLaunchdRun({}, root, { uid: ownUid, log: missingOnly.log })
    expect(missingOnly.entries).toEqual([])
    for (const [error, reason] of [
      [failure('ENOENT'), undefined],
      [failure('EACCES'), 'EACCES'],
      [failure('EPERM'), 'EPERM'],
      [failure('ELOOP'), 'ELOOP'],
      [failure('EISDIR'), 'EISDIR'],
      [failure('EIO'), 'EIO'],
      [plain('ENOENT'), 'UNKNOWN'],
    ] as const) {
      const record = recorder()
      vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
        throw error
      })
      prepareLaunchdRun({}, root, { uid: ownUid, log: record.log })
      expect(record.entries).toEqual(
        reason ? [{ message: 'exit_record_unclear', data: { reason } }] : [],
      )
      const errLog = recorder()
      vi.mocked(fs.openSync).mockImplementationOnce(() => {
        throw error
      })
      prepareLaunchdRun({}, root, { uid: ownUid, log: errLog.log })
      expect(errLog.entries).toEqual(
        reason ? [{ message: 'err_log_skipped', data: { reason } }] : [],
      )
    }
  })

  it('launchd failure reasons are bounded error codes, never raw messages', () => {
    const cases: [unknown, string][] = [
      [failure('EACCES'), 'EACCES'],
      [failure('E_2'), 'E_2'],
      [failure('A'.repeat(40)), 'A'.repeat(40)],
      [failure('A'.repeat(41)), 'UNKNOWN'],
      [failure('eacces'), 'UNKNOWN'],
      [failure(`EACCES ${SECRET}`), 'UNKNOWN'],
      [failure(''), 'UNKNOWN'],
      [failure(13), 'UNKNOWN'],
      [new Error(`raw ${SECRET}`), 'UNKNOWN'],
      [plain('EACCES'), 'UNKNOWN'],
      [`EACCES ${SECRET}`, 'UNKNOWN'],
    ]
    const all = recorder()
    for (const [error, reason] of cases) {
      const record = recorder()
      const log = (scope: string, message: string, data?: unknown) => {
        record.log(scope, message, data)
        all.log(scope, message, data)
      }
      vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
        throw error
      })
      vi.mocked(fs.openSync).mockImplementationOnce(() => {
        throw error
      })
      prepareLaunchdRun({}, root, { uid: ownUid, log })
      expect(record.entries).toEqual([
        { message: 'exit_record_unclear', data: { reason } },
        { message: 'err_log_skipped', data: { reason } },
      ])
    }
    expect(JSON.stringify(all.entries)).not.toContain('secret')
  })

  it('a failed close of the err log is logged by its sanitized code', () => {
    const errLog = join(hostLogDirectory({}, root), 'launchd.err.log')
    mkdirSync(dirname(errLog), { recursive: true })
    writeFileSync(errLog, 'x')
    for (const [error, reason] of [
      [failure('EBADF'), 'EBADF'],
      [failure(`EBADF ${SECRET}`), 'UNKNOWN'],
      [plain('EBADF'), 'UNKNOWN'],
    ] as const) {
      const record = recorder()
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
        actualFs.closeSync(fd)
        throw error
      })
      prepareLaunchdRun({}, root, {
        uid: ownUid,
        stderrIdentity: () => statSync(errLog),
        log: record.log,
      })
      expect(record.entries).toEqual([{ message: 'err_log_skipped', data: { reason } }])
    }
    expect(readFileSync(errLog, 'utf8')).toBe('x')
  })

  it('launchdExit tolerates only a missing staging file at cleanup', async () => {
    const path = serviceExitPath({}, root)
    expect(await launchdExit(78, {}, root, 1000)).toBe(0)
    vi.mocked(promises.unlink).mockRejectedValueOnce(failure('ENOENT'))
    expect(await launchdExit(78, {}, root, 1000)).toBe(0)
    for (const error of [failure('EACCES'), failure('EPERM'), failure('EIO'), plain('ENOENT')]) {
      vi.mocked(promises.unlink).mockRejectedValueOnce(error)
      await expect(launchdExit(78, {}, root, 1000)).rejects.toBe(error)
      expect(await readServiceExit(path)).toBe('config invalid')
    }
    expect(readdirSync(dirname(path))).toEqual(['service-exit.json'])
  })
})

describe('systemd unit files (characterization)', () => {
  it('removeServiceUnit ignores only a missing unit', async () => {
    const path = join(root, 'unit.service')
    await expect(removeServiceUnit(path)).resolves.toBeUndefined()
    vi.mocked(promises.unlink).mockRejectedValueOnce(failure('ENOENT'))
    await expect(removeServiceUnit(path)).resolves.toBeUndefined()
    for (const error of [
      failure('EACCES'),
      failure('EPERM'),
      failure('ELOOP'),
      failure('EIO'),
      plain('ENOENT'),
    ]) {
      vi.mocked(promises.unlink).mockRejectedValueOnce(error)
      await expect(removeServiceUnit(path)).rejects.toBe(error)
    }
    mkdirSync(path)
    await expect(removeServiceUnit(path)).rejects.toMatchObject({
      code: process.platform === 'darwin' ? 'EPERM' : 'EISDIR',
    })
  })

  it('writeServiceUnit publishes the unit and tolerates only a missing staging file', async () => {
    const path = join(root, 'units', 'unit.service')
    await writeServiceUnit(path, 'one')
    vi.mocked(promises.unlink).mockRejectedValueOnce(failure('ENOENT'))
    await writeServiceUnit(path, 'two')
    expect(readFileSync(path, 'utf8')).toBe('two')
    for (const error of [failure('EACCES'), failure('EPERM'), failure('EIO'), plain('ENOENT')]) {
      vi.mocked(promises.unlink).mockRejectedValueOnce(error)
      await expect(writeServiceUnit(path, `after ${String(error.code)}`)).rejects.toBe(error)
      expect(readFileSync(path, 'utf8')).toBe(`after ${String(error.code)}`)
    }
    expect(readdirSync(dirname(path))).toEqual(['unit.service'])
  })
})

const UNSAFE = 'Left unsafe shell startup file unchanged'
const COULD_NOT = 'Could not update shell startup file'

function install(home: string): string[] {
  return installAs(home, ownUid)
}
function installAs(home: string, uid: number | undefined): string[] {
  const print = vi.fn<(line: string) => void>()
  installHostPath({
    home,
    uid,
    platform: 'linux',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    print,
  })
  return print.mock.calls.map(([line]) => line)
}

/** Fail the opens of `path` in turn with `errors` (undefined: the real open); count them. */
function failOpens(path: string, errors: unknown[]): unknown[] {
  const opens: unknown[] = []
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    if (args[0] === path) {
      const error = errors[opens.length]
      opens.push(args[1])
      if (error !== undefined) throw error
    }
    return actualFs.openSync(...args)
  })
  return opens
}

describe('shell startup files (characterization)', () => {
  it('installHostPath creates only a missing rc and refuses every other open failure', () => {
    const path = join(root, '.zshrc')
    expect(install(root)).toEqual([`Added Phosphor Host PATH to ${path}`])
    expect(readFileSync(path, 'utf8')).toBe(HOST_PATH_BLOCK)
    rmSync(path)
    for (const code of ['ELOOP', 'EACCES', 'EPERM', 'ENXIO', 'EISDIR']) {
      const opens = failOpens(path, [failure(code)])
      expect(install(root)).toEqual([`${UNSAFE}: ${path}`])
      expect(opens).toHaveLength(1)
    }
    for (const error of [failure('EIO'), failure('EEXIST'), plain('ENOENT'), plain('ELOOP')]) {
      const opens = failOpens(path, [error])
      expect(install(root)).toEqual([`${COULD_NOT}: ${path}`])
      expect(opens).toHaveLength(1)
    }
    for (const [errors, line] of [
      [[failure('ENOENT'), failure('ENOENT')], UNSAFE],
      [[failure('ENOENT'), failure('EACCES')], UNSAFE],
      [[failure('ENOENT'), failure('EIO')], COULD_NOT],
      [[failure('ENOENT'), plain('EEXIST')], COULD_NOT],
    ] as const) {
      const opens = failOpens(path, [...errors])
      expect(install(root)).toEqual([`${line}: ${path}`])
      expect(opens).toHaveLength(2)
    }
    expect(readdirSync(root)).toEqual([])
    const absent = join(root, 'absent')
    expect(install(absent)).toEqual([`${UNSAFE}: ${join(absent, '.zshrc')}`])
    writeFileSync(path, '# rc\n')
    const opens = failOpens(path, [failure('ENOENT'), failure('EEXIST')])
    expect(install(root)).toEqual([`Added Phosphor Host PATH to ${path}`])
    expect(opens).toHaveLength(3)
    expect(readFileSync(path, 'utf8')).toBe(`# rc\n${HOST_PATH_BLOCK}`)
  })

  it('installHostPath leaves rc files of an unsafe type or owner unchanged', () => {
    const path = join(root, '.zshrc')
    const target = join(root, 'target')
    writeFileSync(target, '# target\n')
    symlinkSync(target, path)
    expect(install(root)).toEqual([`${UNSAFE}: ${path}`])
    expect(readFileSync(target, 'utf8')).toBe('# target\n')
    rmSync(path)
    mkdirSync(path)
    expect(install(root)).toEqual([`${UNSAFE}: ${path}`])
    rmSync(path, { recursive: true })
    execFileSync('mkfifo', [path])
    expect(install(root)).toEqual([`${UNSAFE}: ${path}`])
    expect(statSync(path).isFIFO()).toBe(true)
    rmSync(path)
    writeFileSync(path, '# foreign\n')
    expect(installAs(root, ownUid + 1)).toEqual([`${UNSAFE}: ${path}`])
    expect(installAs(root, undefined)).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('# foreign\n')
  })

  it('removeHostPathBlocks skips a missing or unsafe rc and surfaces any other failure', () => {
    const zshrc = join(root, '.zshrc')
    const bashrc = join(root, '.bashrc')
    removeHostPathBlocks(root, ownUid)
    expect(readdirSync(root)).toEqual([])
    for (const code of ['ENOENT', 'ELOOP', 'EACCES', 'EPERM', 'ENXIO', 'EISDIR']) {
      writeFileSync(bashrc, `# rc\n${HOST_PATH_BLOCK}`)
      failOpens(zshrc, [failure(code)])
      removeHostPathBlocks(root, ownUid)
      expect(readFileSync(bashrc, 'utf8')).toBe('# rc\n')
    }
    for (const error of [failure('EIO'), failure('EEXIST'), plain('ENOENT'), plain('ELOOP')]) {
      writeFileSync(bashrc, `# rc\n${HOST_PATH_BLOCK}`)
      failOpens(zshrc, [error])
      expect(thrownBy(() => removeHostPathBlocks(root, ownUid))).toBe(error)
      expect(readFileSync(bashrc, 'utf8')).toBe(`# rc\n${HOST_PATH_BLOCK}`)
    }
    expect(readdirSync(root)).toEqual(['.bashrc'])
  })

  it('removeHostPathBlocks tolerates only a missing staging file at cleanup', () => {
    const zshrc = join(root, '.zshrc')
    for (const [error, surfaces] of [
      [failure('ENOENT'), false],
      [failure('EACCES'), true],
      [failure('EPERM'), true],
      [failure('EIO'), true],
      [plain('ENOENT'), true],
    ] as const) {
      writeFileSync(zshrc, `# rc\n${HOST_PATH_BLOCK}`)
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        if (basename(String(path)).startsWith('.phosphor-rc-')) throw error
        actualFs.unlinkSync(path)
      })
      expect(thrownBy(() => removeHostPathBlocks(root, ownUid))).toBe(surfaces ? error : undefined)
      expect(readFileSync(zshrc, 'utf8')).toBe('# rc\n')
      expect(readdirSync(root)).toEqual(['.zshrc'])
    }
  })

  it('removeHostPathBlocks keeps its type, owner and inode checks', () => {
    const [zshrc, bashrc, profile] = ['.zshrc', '.bashrc', '.profile'].map((name) =>
      join(root, name),
    )
    if (!zshrc || !bashrc || !profile) throw new Error('fixture')
    const target = join(root, 'target')
    writeFileSync(target, HOST_PATH_BLOCK)
    symlinkSync(target, zshrc)
    mkdirSync(bashrc)
    writeFileSync(profile, HOST_PATH_BLOCK)
    removeHostPathBlocks(root, ownUid + 1)
    removeHostPathBlocks(root, undefined)
    expect(readFileSync(profile, 'utf8')).toBe(HOST_PATH_BLOCK)
    removeHostPathBlocks(root, ownUid)
    expect(readFileSync(target, 'utf8')).toBe(HOST_PATH_BLOCK)
    expect(statSync(bashrc).isDirectory()).toBe(true)
    expect(readFileSync(profile, 'utf8')).toBe('')
    writeFileSync(profile, HOST_PATH_BLOCK)
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      actualFs.fsyncSync(fd)
      renameSync(profile, join(root, 'old'))
      writeFileSync(profile, '# replacement\n')
    })
    removeHostPathBlocks(root, ownUid)
    expect(readFileSync(profile, 'utf8')).toBe('# replacement\n')
    expect(readFileSync(join(root, 'old'), 'utf8')).toBe(HOST_PATH_BLOCK)
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      actualFs.fsyncSync(fd)
      rmSync(join(root, 'old'))
      rmSync(profile)
    })
    writeFileSync(profile, HOST_PATH_BLOCK)
    removeHostPathBlocks(root, ownUid)
    expect(readdirSync(root).sort()).toEqual(['.bashrc', '.zshrc', 'target'])
  })
})

const piEnv = (m: FakeMachine) => buildPiEnvironment({ hostEnv: m.hostEnv, platform: 'linux' })

/** Reject one path's realpath, stat or access; every other path reaches the filesystem. */
function rejectAt(call: 'realpath' | 'stat' | 'access', path: string, error: unknown) {
  if (call === 'realpath')
    vi.mocked(promises.realpath).mockImplementation(async (target, options) => {
      if (target === path) throw error
      return actualPromises.realpath(target, options)
    })
  if (call === 'stat')
    vi.mocked(promises.stat).mockImplementation(async (target, options) => {
      if (target === path) throw error
      return actualPromises.stat(target, options)
    })
  if (call === 'access')
    vi.mocked(promises.access).mockImplementation(async (target, mode) => {
      if (target === path) throw error
      return actualPromises.access(target, mode)
    })
}

describe('executables (characterization)', () => {
  it('resolvePi names a missing pi or node, and reports any other realpath failure by its message', async () => {
    machine = fakeMachine()
    const env = piEnv(machine)
    const missing = join(machine.dir, 'missing')
    const { checks } = await resolvePi({ executable: missing }, env)
    expect(checks).toMatchObject([
      { id: 'pi', status: 'fail', summary: `${missing} does not exist` },
    ])
    for (const [error, text] of [
      [failure('ENOENT', 'ENOENT: raw'), 'does not exist'],
      [plain('ENOENT'), 'does not exist'],
      [failure('EACCES', 'EACCES: raw'), 'EACCES: raw'],
      [failure('ELOOP', 'ELOOP: raw'), 'ELOOP: raw'],
      [failure('EPERM', 'EPERM: raw'), 'EPERM: raw'],
      [plain('EIO'), 'EIO: plain'],
    ] as const) {
      rejectAt('realpath', machine.pi, error)
      const pi = await resolvePi({ node: process.execPath, executable: machine.pi }, env)
      expect(pi.checks).toMatchObject([{ id: 'pi', summary: `${machine.pi} ${text}` }])
      rejectAt('realpath', process.execPath, error)
      const node = await resolvePi({ node: process.execPath, executable: machine.pi }, env)
      expect(node.checks).toMatchObject([
        { id: 'pi-node', status: 'fail', summary: `${process.execPath} ${text}` },
      ])
    }
  })

  it('notExecutable names a missing or non-executable file, and any other failure by its message', async () => {
    machine = fakeMachine()
    const env = piEnv(machine)
    const plainFile = join(machine.dir, 'plain')
    writeFileSync(plainFile, 'not a program')
    const native = await resolvePi({ executable: plainFile }, env)
    expect(native.checks).toMatchObject([
      { id: 'pi', status: 'fail', summary: `${plainFile} is not executable` },
    ])
    const realNode = realpathSync(process.execPath)
    for (const call of ['stat', 'access'] as const) {
      for (const [error, text] of [
        [failure('ENOENT', 'ENOENT: raw'), 'does not exist'],
        [plain('ENOENT'), 'does not exist'],
        [failure('EACCES', 'EACCES: raw'), 'is not executable'],
        [plain('EACCES'), 'is not executable'],
        [failure('EPERM', 'EPERM: raw'), 'EPERM: raw'],
        [failure('ELOOP', 'ELOOP: raw'), 'ELOOP: raw'],
        [plain('EIO'), 'EIO: plain'],
      ] as const) {
        rejectAt(call, realNode, error)
        const { checks } = await resolvePi({ node: process.execPath, executable: machine.pi }, env)
        expect(checks).toMatchObject([
          { id: 'pi-node', status: 'fail', summary: `${process.execPath} ${text}` },
        ])
      }
      vi.mocked(promises[call]).mockReset()
    }
  })

  it('which skips every PATH entry it cannot run, whatever the failure', async () => {
    machine = fakeMachine()
    const tool = machine.script('tool', 'exit 0')
    const first = join(machine.dir, 'first')
    mkdirSync(first)
    writeFileSync(join(first, 'tool'), '#!/bin/sh\n')
    chmodSync(join(first, 'tool'), 0o755)
    const path = [first, machine.bin].join(':')
    expect(await which('tool', path)).toBe(join(first, 'tool'))
    for (const error of [failure('EIO'), failure('EACCES'), plain('ENOENT'), plain('EIO')]) {
      rejectAt('access', join(first, 'tool'), error)
      expect(await which('tool', path)).toBe(tool)
    }
  })
})
