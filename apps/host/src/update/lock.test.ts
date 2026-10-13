import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type * as Fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireInstallLock, deadPid } from './lock'
import { fixture, bundle } from './__fixtures__/release'

const calls = vi.hoisted(() => ({ removed: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    rmdirSync: (...args: Parameters<typeof fs.rmdirSync>) => {
      calls.removed.push(String(args[0]))
      return fs.rmdirSync(...args)
    },
  }
})
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  calls.removed = []
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('acquires/releases by retirement and refuses a concurrent updater', () => {
  const f = setup(),
    release = acquireInstallLock(f.lib)
  expect(readFileSync(join(f.lib, '.install-lock/pid'), 'utf8')).toBe(`${process.pid}\n`)
  expect(() => acquireInstallLock(f.lib)).toThrow('Install lock:')
  release()
  expect(calls.removed).not.toContain(join(f.lib, '.install-lock'))
  expect(calls.removed).toContain(join(f.lib, `.install-lock.retired.${process.pid}`))
  expect(readdirSync(f.lib)).toEqual(['current', 'versions'])
})
it.each(['', 'abc\n', '0\n', '012\n', '1', '1\nextra', '1'.repeat(21)])(
  'refuses missing or malformed owner %j',
  (pid) => {
    const f = setup(),
      lock = join(f.lib, '.install-lock')
    mkdirSync(lock)
    if (pid) writeFileSync(join(lock, 'pid'), pid)
    expect(() => acquireInstallLock(f.lib, () => true)).toThrow(
      'Remove it only if no install or update is running',
    )
    expect(existsSync(lock)).toBe(true)
  },
)
it('rejects linked locks and pid files', () => {
  const f = setup(),
    lock = join(f.lib, '.install-lock')
  symlinkSync(f.old, lock)
  expect(() => acquireInstallLock(f.lib)).toThrow('Install lock:')
  rmSync(lock)
  mkdirSync(lock)
  symlinkSync(join(f.old, 'VERSION'), join(lock, 'pid'))
  expect(() => acquireInstallLock(f.lib)).toThrow('Install lock:')
})
it('reclaims dead installer owners but refuses a gate, changed owner or owner becoming live', () => {
  const f = setup(),
    lock = join(f.lib, '.install-lock')
  const prepare = () => {
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), '999999999\n')
  }
  prepare()
  acquireInstallLock(f.lib, () => true)()
  expect(existsSync(lock)).toBe(false)
  prepare()
  mkdirSync(join(lock, 'recovery'))
  expect(() => acquireInstallLock(f.lib, () => true)).toThrow('Install lock:')
  expect(existsSync(join(lock, 'recovery'))).toBe(true)
  rmSync(lock, { recursive: true })
  prepare()
  let checks = 0
  expect(() => acquireInstallLock(f.lib, () => ++checks === 1)).toThrow('Install lock:')
  expect(existsSync(join(lock, 'recovery'))).toBe(false)
  expect(() =>
    acquireInstallLock(f.lib, () => {
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`)
      return true
    }),
  ).toThrow('Install lock:')
})
it('sweeps at most 16 exact dead non-link retired folders, never lookalikes or live owners', () => {
  const f = setup()
  for (let i = 1; i <= 17; i++) {
    const path = join(f.lib, `.install-lock.retired.${1000000 + i}`)
    mkdirSync(path)
    writeFileSync(join(path, 'pid'), '1\n')
  }
  for (const name of [
    '.install-lock.retired.01',
    '.install-lock.retired.12.bak',
    '.install-lock.retired.12345678901',
  ])
    mkdirSync(join(f.lib, name))
  symlinkSync(f.old, join(f.lib, '.install-lock.retired.100'))
  acquireInstallLock(f.lib, () => true)()
  expect(
    readdirSync(f.lib).filter((n) => /^\.install-lock\.retired\.10000[0-9]+$/.test(n)),
  ).toHaveLength(1)
  expect(existsSync(join(f.lib, '.install-lock.retired.01'))).toBe(true)
  expect(existsSync(join(f.lib, '.install-lock.retired.100'))).toBe(true)
  expect(deadPid(process.pid)).toBe(false)
  expect(deadPid(999999999)).toBe(true)
})
it('interoperates both ways with the real generated installer and reclaims its dead pid', () => {
  const f = setup(),
    script = join(f.home, 'install.sh')
  // Real installer uses the machine platform. The manifest is signed for both test targets.
  const target = `${process.platform}-${process.arch}`
  f.release(
    '1.2.3',
    bundle(),
    (m) => {
      const a = m.artifacts[0]
      if (a && target === 'darwin-arm64') {
        a.target = 'darwin-arm64'
        a.file = 'phosphor-host-1.2.3-darwin-arm64.tar.gz'
      }
    },
    '1.2.3',
  )
  writeFileSync(join(f.assets, `phosphor-host-1.2.3-${target}.tar.gz`), bundle())
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(script)},${JSON.stringify(f.keys)})`,
    ],
    { cwd: resolve('.'), stdio: 'pipe' },
  )
  const release = acquireInstallLock(f.lib)
  const result = spawnSync('sh', [script, '1.2.3'], {
    env: {
      HOME: f.home,
      PATH: process.env.PATH,
      TMPDIR: f.home,
      PHOSPHOR_HOST_RELEASE_URL: f.context.env.PHOSPHOR_HOST_RELEASE_URL,
    },
    encoding: 'utf8',
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Install lock:')
  release()
  // A live actual installer process pauses immediately after writing its own pid.
  const text = readFileSync(script, 'utf8').replace(
    'end_critical\n[ ! -e "$root/current" ]',
    'end_critical\nprintf "ready\\n" > "$HOME/ready"\nwhile [ ! -f "$HOME/continue" ]; do sleep 0.05; done\n[ ! -e "$root/current" ]',
  )
  writeFileSync(script, text)
  // Run in a child; no system service or real HOME is used.
  const childScript = `const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn('sh',${JSON.stringify([script, '1.2.3'])},{env:${JSON.stringify({ HOME: f.home, PATH: process.env.PATH, TMPDIR: f.home, PHOSPHOR_HOST_RELEASE_URL: f.context.env.PHOSPHOR_HOST_RELEASE_URL })},stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(f.home, 'ready'))})){process.stdout.write(String(c.pid));clearInterval(t);c.unref()}},10);`
  const pid = Number(
    execFileSync(process.execPath, ['-e', childScript], { encoding: 'utf8', timeout: 10000 }),
  )
  try {
    expect(() => acquireInstallLock(f.lib)).toThrow('Install lock:')
  } finally {
    process.kill(pid, 'SIGKILL')
  }
  // The killed installer may still be reaped asynchronously; inject the observed dead owner for deterministic reclamation.
  const owner = Number(readFileSync(join(f.lib, '.install-lock/pid'), 'utf8').trim())
  expect(owner).toBe(pid)
  acquireInstallLock(f.lib, (p) => p === pid)()
})
