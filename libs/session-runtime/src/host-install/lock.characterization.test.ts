import type * as Fs from 'node:fs'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireInstallLock, deadPid, hasCode } from './lock'

/*
 * Pins the install lock protocol shared with the generated installer
 * (docs/host.md, Install): every refusal and recovery outcome, the bounded
 * retired-folder sweep and the exact filesystem operations in order. A trace
 * names paths relative to the lib folder; `!CODE` marks a call that threw and
 * `dead <pid> <verdict>` is a dead-pid port answer.
 */
const io = vi.hoisted(() => {
  const io = {
    lib: '',
    ops: [] as string[],
    before: undefined as ((op: string) => void) | undefined,
    /** Fixture work inside a hook or port is another process's I/O, not the lock's. */
    quiet<T>(action: () => T): T {
      const lib = io.lib
      io.lib = ''
      try {
        return action()
      } finally {
        io.lib = lib
      }
    },
  }
  return io
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  const traced =
    <A extends unknown[], R>(name: string, call: (...args: A) => R, paths = 1) =>
    (...args: A): R => {
      const lib = io.lib
      if (!lib) return call(...args)
      const named = args.slice(0, paths).map((path) => String(path).slice(lib.length + 1) || '.')
      const op = [name, ...named].join(' ')
      try {
        const hook = io.before
        if (hook) io.quiet(() => hook(op))
        const result = call(...args)
        io.ops.push(op)
        return result
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'Error'
        io.ops.push(`${op} !${code}`)
        throw error
      }
    }
  return {
    ...fs,
    lstatSync: traced('lstat', fs.lstatSync),
    mkdirSync: traced('mkdir', fs.mkdirSync),
    readFileSync: traced('readFile', fs.readFileSync),
    readdirSync: traced('readdir', fs.readdirSync),
    renameSync: traced('rename', fs.renameSync, 2),
    rmdirSync: traced('rmdir', fs.rmdirSync),
    unlinkSync: traced('unlink', fs.unlinkSync),
    writeFileSync: traced('writeFile', fs.writeFileSync),
  }
})

const L = '.install-lock'
const R = `.install-lock.retired.${process.pid}`
const CLAIM = ['readdir .', `mkdir ${L} !EEXIST`, `lstat ${L}`, `lstat ${L}/pid`]
const OWNER = [...CLAIM, `readFile ${L}/pid`]
const RETIRE = [`lstat ${R} !ENOENT`, `rename ${L} ${R}`, `unlink ${R}/pid`]
const RELEASE = [...RETIRE, `lstat ${R}/recovery !ENOENT`, `rmdir ${R}`]
const GATE = [...OWNER, 'dead 999999999 true', `mkdir ${L}/recovery`]
const RECHECK = [...GATE, `lstat ${L}/pid`, `readFile ${L}/pid`]
const RECLAIM = [
  ...RECHECK,
  'dead 999999999 true',
  ...RETIRE,
  `lstat ${R}/recovery`,
  `rmdir ${R}/recovery`,
  `rmdir ${R}`,
  `mkdir ${L}`,
  `writeFile ${L}/pid`,
]

const homes: string[] = []
afterEach(() => {
  io.lib = ''
  io.ops = []
  io.before = undefined
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-lock-')))
  homes.push(home)
  const lib = join(home, 'lib')
  mkdirSync(lib)
  return { home, lib, lock: join(lib, L), retired: join(lib, R) }
}
function ownedLock(lib: string, pid = '999999999\n'): string {
  const lock = join(lib, L)
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), pid)
  return lock
}
function retiredFolder(lib: string, name: string, pid: string | null = '1\n', recovery = true) {
  const path = join(lib, `.install-lock.retired.${name}`)
  mkdirSync(path)
  if (pid !== null) writeFileSync(join(path, 'pid'), pid)
  if (recovery) mkdirSync(join(path, 'recovery'))
  return path
}
/** Runs `action` with the lock's filesystem calls traced. */
function run<T>(lib: string, action: () => T): T {
  io.lib = lib
  try {
    return action()
  } finally {
    io.lib = ''
  }
}
function thrown(lib: string, action: () => unknown): unknown {
  try {
    run(lib, action)
  } catch (error) {
    return error
  }
  throw new Error('expected the action to throw')
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const code = (error: unknown) =>
  error instanceof Error && 'code' in error ? String(error.code) : undefined
/** The message of what `action` threw, traced. */
const failure = (lib: string, action: () => unknown) => message(thrown(lib, action))
const refusal = (lib: string) =>
  `Install lock: ${join(lib, L)}. Remove it only if no install or update is running.`
/** Another process acts just before the lock's first `op`; it can also fail that call. */
function before(op: string, action: () => void) {
  io.before = (next) => {
    if (next !== op) return
    io.before = undefined
    action()
  }
}
/** A dead-pid port whose answers join the trace. */
function port(verdict: (pid: number) => boolean) {
  return (pid: number): boolean => {
    try {
      const dead = io.quiet(() => verdict(pid))
      io.ops.push(`dead ${pid} ${dead}`)
      return dead
    } catch (error) {
      io.ops.push(`dead ${pid} !${message(error)}`)
      throw error
    }
  }
}
const allDead = () => port(() => true)
const allLive = () => port(() => false)
/** Acquisition through a dead-pid port; every owner is dead by default. */
const acquire = (lib: string, dead = allDead()) => {
  return () => acquireInstallLock(lib, dead)
}
const deadPorts = (ops: readonly string[]) => ops.filter((op) => op.startsWith('dead '))
/** The first path segment of every traced call. */
const touched = (ops: readonly string[]) =>
  new Set(ops.flatMap((op) => op.split(' ').slice(1)).map((path) => path.split('/')[0]))

describe('refusals', () => {
  it('refuses a live owner with the exact message, touching nothing', () => {
    const { lib, lock } = setup()
    ownedLock(lib, `${process.pid}\n`)
    const error = thrown(lib, () => acquireInstallLock(lib))
    expect(message(error)).toBe(refusal(lib))
    expect(code(error)).toBeUndefined()
    expect(io.ops).toEqual(OWNER)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
    expect(readdirSync(lock)).toEqual(['pid'])
  })
  it('asks the dead-pid port about the owner and refuses when it is live', () => {
    const { lib, lock } = setup()
    ownedLock(lib)
    expect(failure(lib, acquire(lib, allLive()))).toBe(refusal(lib))
    expect(io.ops).toEqual([...OWNER, 'dead 999999999 false'])
    expect(readdirSync(lock)).toEqual(['pid'])
  })
  it.each([
    '',
    '0\n',
    '012\n',
    '1',
    '1\n\n',
    ' 1\n',
    '+1\n',
    '1\r\n',
    '1\nextra',
    '12345678901\n',
    `${'1'.repeat(19)}\n`,
  ])('refuses a malformed owner %j without asking the port', (pid) => {
    const { lib, lock } = setup()
    ownedLock(lib, pid)
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual(OWNER)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(pid)
    expect(readdirSync(lock)).toEqual(['pid'])
  })
  it('refuses a pid file over 20 bytes, a pid folder or a pid link before reading it', () => {
    const { home, lib, lock } = setup()
    ownedLock(lib, '1'.repeat(21))
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual(CLAIM)
    rmSync(lock, { recursive: true })
    mkdirSync(join(lock, 'pid'), { recursive: true })
    io.ops = []
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual(CLAIM)
    rmSync(lock, { recursive: true })
    mkdirSync(lock)
    writeFileSync(join(home, 'pid'), '999999999\n')
    symlinkSync(join(home, 'pid'), join(lock, 'pid'))
    io.ops = []
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual(CLAIM)
    expect(lstatSync(join(lock, 'pid')).isSymbolicLink()).toBe(true)
  })
  it('refuses a missing owner, whose installer may still be writing it', () => {
    const { lib, lock } = setup()
    mkdirSync(lock)
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([...CLAIM.slice(0, 3), `lstat ${L}/pid !ENOENT`])
    expect(readdirSync(lock)).toEqual([])
  })
  it.each(['link', 'file'])('refuses a lock path that is a %s', (kind) => {
    const { home, lib, lock } = setup()
    const target = join(home, 'elsewhere')
    mkdirSync(target)
    writeFileSync(join(target, 'pid'), '999999999\n')
    if (kind === 'link') symlinkSync(target, lock)
    else writeFileSync(lock, '999999999\n')
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual(CLAIM.slice(0, 3))
    expect(lstatSync(lock).isSymbolicLink()).toBe(kind === 'link')
    expect(readdirSync(target)).toEqual(['pid'])
  })
  it.each(['folder', 'link'])('refuses an abandoned recovery gate %s and keeps it', (kind) => {
    const { home, lib, lock } = setup()
    ownedLock(lib)
    mkdirSync(join(home, 'gate'))
    if (kind === 'folder') mkdirSync(join(lock, 'recovery'))
    else symlinkSync(join(home, 'gate'), join(lock, 'recovery'))
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([...GATE.slice(0, -1), `mkdir ${L}/recovery !EEXIST`])
    expect(lstatSync(join(lock, 'recovery')).isSymbolicLink()).toBe(kind === 'link')
    expect(existsSync(join(home, 'gate'))).toBe(true)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('999999999\n')
  })
})

describe('reclamation', () => {
  it('reclaims a dead owner under the recovery gate and releases by retirement', () => {
    const { lib, lock } = setup()
    ownedLock(lib)
    const release = run(lib, acquire(lib))
    expect(io.ops).toEqual(RECLAIM)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
    expect(readdirSync(lock)).toEqual(['pid'])
    io.ops = []
    run(lib, release)
    expect(io.ops).toEqual(RELEASE)
    expect(readdirSync(lib)).toEqual([])
  })
  it.each([
    ['file', [`lstat ${R}`]],
    ['link', [`lstat ${R}`]],
    ['folder', [`lstat ${R}`, `dead ${process.pid} false`]],
  ])('refuses an occupied retired name (%s) and releases its own gate', (kind, sweep) => {
    const { home, lib, lock, retired } = setup()
    ownedLock(lib)
    mkdirSync(join(home, 'target'))
    if (kind === 'file') writeFileSync(retired, 'x')
    else if (kind === 'link') symlinkSync(join(home, 'target'), retired)
    else retiredFolder(lib, String(process.pid))
    const dead = port((pid) => pid !== process.pid)
    expect(failure(lib, acquire(lib, dead))).toBe(refusal(lib))
    expect(io.ops).toEqual([
      'readdir .',
      ...sweep,
      ...RECHECK.slice(1),
      'dead 999999999 true',
      `lstat ${R}`,
      `rmdir ${L}/recovery`,
    ])
    expect(readdirSync(lock)).toEqual(['pid'])
    expect(lstatSync(retired).isSymbolicLink()).toBe(kind === 'link')
    if (kind === 'folder') expect(readdirSync(retired).sort()).toEqual(['pid', 'recovery'])
  })
  it('refuses an owner changed during reclamation and releases its own gate', () => {
    const { lib, lock } = setup()
    ownedLock(lib)
    const dead = port(() => {
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`)
      return true
    })
    expect(failure(lib, acquire(lib, dead))).toBe(refusal(lib))
    expect(io.ops).toEqual([...RECHECK, `rmdir ${L}/recovery`])
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
    expect(readdirSync(lock)).toEqual(['pid'])
  })
  it('refuses an owner that turns live, malformed or missing on the recheck', () => {
    const { lib, lock } = setup()
    ownedLock(lib)
    let checks = 0
    const live = port(() => ++checks === 1)
    expect(failure(lib, acquire(lib, live))).toBe(refusal(lib))
    expect(io.ops).toEqual([...RECHECK, 'dead 999999999 false', `rmdir ${L}/recovery`])
    for (const [change, recheck] of [
      ['x\n', [`lstat ${L}/pid`, `readFile ${L}/pid`]],
      [null, [`lstat ${L}/pid !ENOENT`]],
    ] as const) {
      io.ops = []
      const dead = port(() => {
        if (change === null) rmSync(join(lock, 'pid'))
        else writeFileSync(join(lock, 'pid'), change)
        return true
      })
      expect(failure(lib, acquire(lib, dead))).toBe(refusal(lib))
      expect(io.ops).toEqual([...GATE, ...recheck, `rmdir ${L}/recovery`])
      expect(existsSync(join(lock, 'recovery'))).toBe(false)
      writeFileSync(join(lock, 'pid'), '999999999\n')
    }
  })
  it('turns a port failure during reclamation into a refusal before taking the gate', () => {
    const { lib, lock } = setup()
    ownedLock(lib)
    const dead = port(() => {
      throw new Error('port failed')
    })
    expect(failure(lib, acquire(lib, dead))).toBe(refusal(lib))
    expect(io.ops).toEqual([...OWNER, 'dead 999999999 !port failed'])
    expect(readdirSync(lock)).toEqual(['pid'])
  })
  it('leaves a lock taken after its rename to the new owner and refuses', () => {
    const { lib, lock, retired } = setup()
    ownedLock(lib)
    before(`unlink ${R}/pid`, () => ownedLock(lib, '4242\n'))
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([...RECLAIM.slice(0, -2), `mkdir ${L} !EEXIST`])
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('4242\n')
    expect(readdirSync(lock)).toEqual(['pid'])
    expect(existsSync(retired)).toBe(false)
  })
  it('moves the gate with the lock: a failed retired cleanup never touches the lock path', () => {
    const { lib, lock, retired } = setup()
    ownedLock(lib)
    before(`rmdir ${R}`, () => {
      writeFileSync(join(retired, 'extra'), '')
      ownedLock(lib, '4242\n')
      mkdirSync(join(lock, 'recovery'))
    })
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([...RECLAIM.slice(0, -3), `rmdir ${R} !ENOTEMPTY`])
    expect(readdirSync(lock).sort()).toEqual(['pid', 'recovery'])
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('4242\n')
    expect(readdirSync(retired)).toEqual(['extra'])
  })
})

describe('retired-folder sweep', () => {
  const lookalikes = [
    '.install-lock.retired.',
    '.install-lock.retired.0',
    '.install-lock.retired.01',
    '.install-lock.retired.-5',
    '.install-lock.retired.5x',
    '.install-lock.retired.12.bak',
    '.install-lock.retired.12345678901',
    'x.install-lock.retired.5',
  ]
  it('examines at most 16 exact folders, removing dead ones, never lookalikes or links', () => {
    const { home, lib, lock } = setup()
    const pids = Array.from({ length: 17 }, (_, i) => 1000001 + i)
    for (const pid of pids) retiredFolder(lib, String(pid))
    for (const name of lookalikes) mkdirSync(join(lib, name))
    mkdirSync(join(home, 'target'))
    symlinkSync(join(home, 'target'), join(lib, '.install-lock.retired.100'))
    writeFileSync(join(lib, '.install-lock.retired.200'), '')
    run(lib, acquire(lib))
    const asked = deadPorts(io.ops).map((op) => Number(op.split(' ')[1]))
    expect(asked).toHaveLength(16)
    expect(new Set(asked).size).toBe(16)
    const kept = pids.filter((pid) => !asked.includes(pid))
    expect(kept).toHaveLength(1)
    for (const pid of asked) {
      const name = `.install-lock.retired.${pid}`
      expect(io.ops.filter((op) => op.split(' ')[1]?.split('/')[0] === name)).toEqual([
        `lstat ${name}`,
        `unlink ${name}/pid`,
        `lstat ${name}/recovery`,
        `rmdir ${name}/recovery`,
        `rmdir ${name}`,
      ])
    }
    const names = readdirSync(lib)
    const swept = names.filter((name) => /^\.install-lock\.retired\.10000\d\d$/.test(name))
    expect(swept).toEqual([`.install-lock.retired.${kept[0]}`])
    for (const name of lookalikes) expect(touched(io.ops).has(name)).toBe(false)
    for (const name of [...lookalikes, '.install-lock.retired.100', '.install-lock.retired.200'])
      expect(names).toContain(name)
    expect(existsSync(join(home, 'target'))).toBe(true)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
  })
  it('does not count links or files toward the bound', () => {
    const { home, lib } = setup()
    for (let i = 1; i <= 16; i++) retiredFolder(lib, String(2000000 + i))
    mkdirSync(join(home, 'target'))
    symlinkSync(join(home, 'target'), join(lib, '.install-lock.retired.100'))
    writeFileSync(join(lib, '.install-lock.retired.200'), '')
    run(lib, acquire(lib))
    expect(deadPorts(io.ops)).toHaveLength(16)
    const left = readdirSync(lib).sort()
    expect(left).toEqual([L, '.install-lock.retired.100', '.install-lock.retired.200'])
  })
  it('counts live owners toward the bound and keeps their folders intact', () => {
    const { lib } = setup()
    for (let i = 1; i <= 17; i++) retiredFolder(lib, String(3000000 + i))
    run(lib, acquire(lib, allLive()))
    expect(deadPorts(io.ops)).toHaveLength(16)
    const retired = readdirSync(lib).filter((name) => name !== L)
    expect(retired).toHaveLength(17)
    for (const name of retired)
      expect(readdirSync(join(lib, name)).sort()).toEqual(['pid', 'recovery'])
  })
  it('matches one to ten digits without a leading zero and asks the port by number', () => {
    const { lib } = setup()
    retiredFolder(lib, '1')
    retiredFolder(lib, '9999999999')
    run(lib, acquire(lib, allLive()))
    expect(deadPorts(io.ops).sort()).toEqual(['dead 1 false', 'dead 9999999999 false'])
  })
  it('removes an empty dead folder, tolerating its missing pid and gate', () => {
    const { lib } = setup()
    const name = '.install-lock.retired.4000001'
    retiredFolder(lib, '4000001', null, false)
    run(lib, acquire(lib))
    expect(io.ops).toEqual([
      'readdir .',
      `lstat ${name}`,
      'dead 4000001 true',
      `unlink ${name}/pid !ENOENT`,
      `lstat ${name}/recovery !ENOENT`,
      `rmdir ${name}`,
      `mkdir ${L}`,
      `writeFile ${L}/pid`,
    ])
    expect(readdirSync(lib)).toEqual([L])
  })
  it.each([
    ['an unknown file', 'extra', 'rmdir .install-lock.retired.5000001 !ENOTEMPTY', 'extra'],
    ['a non-empty gate', 'inner', 'rmdir .install-lock.retired.5000001/recovery !ENOTEMPTY'],
    ['a gate file', 'file', 'rmdir .install-lock.retired.5000001/recovery !ENOTDIR'],
  ])('stops acquisition when a dead folder holds %s', (_, content, failed, left = 'recovery') => {
    const { lib } = setup()
    const name = '.install-lock.retired.5000001'
    const path = retiredFolder(lib, '5000001', '1\n', content === 'extra')
    if (content === 'extra') writeFileSync(join(path, 'extra'), '')
    else if (content === 'file') writeFileSync(join(path, 'recovery'), '')
    else mkdirSync(join(path, 'recovery', 'inner'), { recursive: true })
    const error = thrown(lib, acquire(lib))
    expect(code(error)).toBe(failed.split('!')[1])
    const removal = ['readdir .', `lstat ${name}`, 'dead 5000001 true', `unlink ${name}/pid`]
    expect(io.ops.slice(0, 4)).toEqual(removal)
    expect(io.ops.at(-1)).toBe(failed)
    expect(io.ops.some((op) => op.startsWith(`mkdir ${L}`))).toBe(false)
    expect(readdirSync(lib)).toEqual([name])
    expect(readdirSync(path)).toEqual([left])
  })
  it('refuses a dead folder whose gate is a link, before acquiring', () => {
    const { home, lib } = setup()
    const path = retiredFolder(lib, '5000002', '1\n', false)
    mkdirSync(join(home, 'gate'))
    writeFileSync(join(home, 'gate', 'keep'), '')
    symlinkSync(join(home, 'gate'), join(path, 'recovery'))
    const name = '.install-lock.retired.5000002'
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([
      'readdir .',
      `lstat ${name}`,
      'dead 5000002 true',
      `unlink ${name}/pid`,
      `lstat ${name}/recovery`,
    ])
    expect(readdirSync(join(home, 'gate'))).toEqual(['keep'])
    expect(readdirSync(lib)).toEqual([name])
  })
  it('stops acquisition when a dead folder pid is a folder', () => {
    const { lib } = setup()
    const path = retiredFolder(lib, '5000003', null, false)
    mkdirSync(join(path, 'pid'))
    const error = thrown(lib, acquire(lib))
    expect(['EPERM', 'EISDIR']).toContain(code(error))
    expect(readdirSync(lib)).toEqual(['.install-lock.retired.5000003'])
    expect(statSync(join(path, 'pid')).isDirectory()).toBe(true)
  })
  it('lets a port failure during the sweep escape unchanged', () => {
    const { lib } = setup()
    retiredFolder(lib, '6000001')
    const failed = new Error('port failed')
    const dead = port(() => {
      throw failed
    })
    expect(thrown(lib, acquire(lib, dead))).toBe(failed)
    expect(readdirSync(lib)).toEqual(['.install-lock.retired.6000001'])
  })
})

describe('pid publication and release', () => {
  it('publishes "<pid>\\n" at 0600 in a fresh lock; release retires it, never in place', () => {
    const { lib, lock } = setup()
    const release = run(lib, acquire(lib))
    expect(io.ops).toEqual(['readdir .', `mkdir ${L}`, `writeFile ${L}/pid`])
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
    expect(statSync(join(lock, 'pid')).mode & 0o777).toBe(0o600)
    io.ops = []
    run(lib, release)
    expect(io.ops).toEqual(RELEASE)
    expect(readdirSync(lib)).toEqual([])
  })
  it('retires its own lock when pid publication fails and rethrows that failure', () => {
    const { lib } = setup()
    const failed = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    before(`writeFile ${L}/pid`, () => {
      throw failed
    })
    expect(thrown(lib, acquire(lib))).toBe(failed)
    expect(io.ops).toEqual([
      'readdir .',
      `mkdir ${L}`,
      `writeFile ${L}/pid !ENOSPC`,
      ...RETIRE.slice(0, 2),
      `unlink ${R}/pid !ENOENT`,
      ...RELEASE.slice(3),
    ])
    expect(readdirSync(lib)).toEqual([])
  })
  it('publishes exclusively: a pid already in its fresh lock fails and is retired', () => {
    const { lib, lock } = setup()
    before(`writeFile ${L}/pid`, () => writeFileSync(join(lock, 'pid'), '4242\n'))
    expect(code(thrown(lib, acquire(lib)))).toBe('EEXIST')
    expect(io.ops).toEqual(['readdir .', `mkdir ${L}`, `writeFile ${L}/pid !EEXIST`, ...RELEASE])
    expect(readdirSync(lib)).toEqual([])
  })
  it('refuses instead of rethrowing when a failed publication finds its retired name taken', () => {
    const { lib, lock, retired } = setup()
    writeFileSync(retired, 'x')
    before(`writeFile ${L}/pid`, () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    expect(failure(lib, acquire(lib))).toBe(refusal(lib))
    expect(io.ops).toEqual([
      'readdir .',
      `lstat ${R}`,
      `mkdir ${L}`,
      `writeFile ${L}/pid !ENOSPC`,
      `lstat ${R}`,
    ])
    expect(readdirSync(lock)).toEqual([])
    expect(readFileSync(retired, 'utf8')).toBe('x')
  })
  it('cannot delete a new owner who takes the lock path during release', () => {
    const { lib, lock, retired } = setup()
    const release = run(lib, acquire(lib))
    io.ops = []
    before(`unlink ${R}/pid`, () => ownedLock(lib, '4242\n'))
    run(lib, release)
    expect(io.ops).toEqual(RELEASE)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('4242\n')
    expect(readdirSync(lock)).toEqual(['pid'])
    expect(existsSync(retired)).toBe(false)
  })
  it('refuses release while its retired name is occupied and keeps the lock', () => {
    const { lib, lock, retired } = setup()
    const release = run(lib, acquire(lib))
    writeFileSync(retired, 'x')
    io.ops = []
    expect(failure(lib, release)).toBe(refusal(lib))
    expect(io.ops).toEqual([`lstat ${R}`])
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
  })
})

describe('deadPid and hasCode', () => {
  it('deadPid is true only for an Error with ESRCH from signal 0', () => {
    expect(deadPid(process.pid)).toBe(false)
    expect(deadPid(999999999)).toBe(true)
    const kill = vi.spyOn(process, 'kill')
    for (const [thrownByKill, dead] of [
      [Object.assign(new Error('gone'), { code: 'ESRCH' }), true],
      [Object.assign(new Error('not ours'), { code: 'EPERM' }), false],
      [{ code: 'ESRCH' }, false],
      [new Error('no code'), false],
    ] as const) {
      kill.mockImplementationOnce(() => {
        throw thrownByKill
      })
      expect(deadPid(4242)).toBe(dead)
    }
    expect(kill.mock.calls).toEqual(Array.from({ length: 4 }, () => [4242, 0]))
  })
  it('hasCode accepts only an Error carrying exactly that code', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    expect(hasCode(enoent, 'ENOENT')).toBe(true)
    expect(hasCode(enoent, 'EEXIST')).toBe(false)
    expect(hasCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false)
    expect(hasCode(new Error('missing'), 'ENOENT')).toBe(false)
    expect(hasCode(Object.assign(new Error('odd'), { code: 2 }), '2')).toBe(false)
    expect(hasCode(null, 'ENOENT')).toBe(false)
    expect(hasCode('ENOENT', 'ENOENT')).toBe(false)
  })
})
