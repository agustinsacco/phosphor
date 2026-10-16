import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { controlMachine, type ControlMachine } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { HOST_UNIT, type ServiceRunner } from '../machine/systemd'
import { runService, type ServiceContext } from './service'
import { HOST_AGENT, launchdExit } from '../machine/launchd'
import { hostLogDirectory } from '../machine/log'
import { runCli } from '../cli'

let machine: ControlMachine
beforeEach(async () => {
  machine = await controlMachine()
})
afterEach(async () => {
  await machine.cleanup()
})
function fixture() {
  const calls: { file: string; args: readonly string[]; follow?: boolean }[] = []
  const runner: ServiceRunner = async (file, args, follow) => {
    calls.push({ file, args, follow })
    return {
      code: args.includes('is-active') ? 3 : 0,
      stdout: args.includes('show')
        ? 'ActiveState=active\nSubState=running\nMainPID=123\nExecMainStatus=0\nsecret=hidden'
        : 'yes',
    }
  }
  const context: ServiceContext = {
    ...machine.context,
    home: machine.root,
    nodeVersion: process.versions.node,
    defaultResourceRoot: '/unused',
    env: {
      XDG_CONFIG_HOME: join(machine.root, 'xdg'),
      PATH: '/custom/bin:/bin',
      SECRET_TOKEN: 'must-not-appear',
    },
    service: { runner, node: '/opt/node path', bundle: '/opt/phosphor.mjs', user: 'testuser' },
  }
  return { calls, context, unit: join(machine.root, 'xdg', 'systemd', 'user', HOST_UNIT) }
}
describe('phosphor service', () => {
  it.each(['linux', 'darwin'] as const)(
    'installs %s release service paths through current',
    async (platform) => {
      await machine.enrollOld()
      const f = fixture(),
        lib = join(machine.root, '.local/lib/phosphor-host'),
        folder = join(lib, 'versions/1.2.3')
      for (const name of ['node/bin/node', 'lib/phosphor.mjs']) {
        mkdirSync(join(folder, name, '..'), { recursive: true })
        writeFileSync(join(folder, name), 'test')
      }
      symlinkSync('versions/1.2.3', join(lib, 'current'))
      f.context.platform = platform
      f.context.service = {
        ...f.context.service,
        node: join(folder, 'node/bin/node'),
        bundle: join(folder, 'lib/phosphor.mjs'),
      }
      expect(await runService(f.context, 'install')).toBe(0)
      const path =
        platform === 'linux'
          ? f.unit
          : join(machine.root, 'Library/LaunchAgents', `${HOST_AGENT}.plist`)
      const text = await readFile(path, 'utf8')
      expect(text).toContain(join(lib, 'current/node/bin/node'))
      expect(text).toContain(join(lib, 'current/lib/phosphor.mjs'))
      expect(text).not.toContain('versions/1.2.3')
    },
  )
  it.each([
    ['service'],
    ['service', 'unknown'],
    ['service', 'logs', 'extra'],
    ['service', 'install', '--follow'],
    ['run', '--json'],
    ['run', 'extra'],
  ])('rejects CLI arguments %j before any I/O', async (...argv) => {
    const f = fixture()
    const stderr: string[] = []
    expect(
      await runCli(
        argv,
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
        {
          ...f.context,
          nodeVersion: process.versions.node,
          defaultResourceRoot: '/unused',
        },
      ),
    ).toBe(64)
    expect(stderr.join('')).toContain('usage:')
    expect(f.calls).toEqual([])
  })
  it('dispatches CLI service logs with follow using a single shutdown attachment', async () => {
    const f = fixture()
    let attached = 0
    let detached = 0
    expect(
      await runCli(
        ['service', 'logs', '--follow', '--config', machine.configPath],
        {
          stdout: () => {},
          stderr: () => {},
        },
        {
          ...f.context,
          nodeVersion: process.versions.node,
          defaultResourceRoot: '/unused',
          attach: () => {
            attached++
            return () => {
              detached++
            }
          },
        },
      ),
    ).toBe(0)
    expect(f.calls[0]?.args).toContain('-f')
    expect(attached).toBe(1)
    expect(detached).toBe(1)
  })
  it('installs and replaces with fake calls, and captures PATH but no other environment', async () => {
    await machine.enrollOld()
    const f = fixture()
    expect(await runService(f.context, 'install')).toBe(0)
    const text = await readFile(f.unit, 'utf8')
    expect(text).toContain('Environment="PATH=/opt:/custom/bin:/bin"')
    expect(text).toContain('"/opt/node path" "/opt/phosphor.mjs" "run" "--config"')
    expect(text).not.toContain('must-not-appear')
    expect(f.calls.map(({ file, args }) => [file, args])).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', HOST_UNIT]],
      ['systemctl', ['--user', 'restart', HOST_UNIT]],
      ['loginctl', ['enable-linger', 'testuser']],
    ])
    expect(await runService(f.context, 'install')).toBe(0)
    expect(await readFile(f.unit, 'utf8')).toBe(text)
  })
  it('puts the real node directory first in PATH, once, so a per-shell entry may vanish', async () => {
    await machine.enrollOld()
    const f = fixture()
    f.context.env = {
      ...f.context.env,
      PATH: '/run/user/1000/fnm_multishells/1_2/bin::/opt/fnm/v22/bin:/bin',
    }
    f.context.service = { ...f.context.service, node: '/opt/fnm/v22/bin/node' }
    expect(await runService(f.context, 'install')).toBe(0)
    expect(await readFile(f.unit, 'utf8')).toContain(
      'Environment="PATH=/opt/fnm/v22/bin:/run/user/1000/fnm_multishells/1_2/bin:/bin"',
    )
  })
  it('prints the exact sudo command on linger failure without running sudo', async () => {
    await machine.enrollOld()
    const f = fixture()
    const original = f.context.service?.runner
    if (!f.context.service || !original) throw new Error('fixture')
    f.context.service.runner = async (...args) => {
      const result = await original(...args)
      return args[0] === 'loginctl' ? { code: 1, stdout: 'secret' } : result
    }
    expect(await runService(f.context, 'install')).toBe(0)
    expect(machine.output.join('\n')).toContain('sudo loginctl enable-linger testuser')
    expect(f.calls.some((call) => call.file === 'sudo')).toBe(false)
    expect(machine.output.join('\n')).not.toContain('secret')
  })
  it('requires enrollment and refuses unsupported platforms without any service calls', async () => {
    const f = fixture()
    expect(await runService(f.context, 'install')).toBe(69)
    for (const action of ['install', 'status', 'restart', 'logs', 'uninstall'] as const)
      expect(await runService({ ...f.context, platform: 'win32' }, action)).toBe(69)
    expect(f.calls).toEqual([])
    expect(machine.output).toContain('not supported on this platform yet')
  })
  it('refuses newlines before writing or running anything', async () => {
    await machine.enrollOld()
    const f = fixture()
    if (!f.context.service) throw new Error('fixture')
    f.context.service.node = '/node\npath'
    expect(await runService(f.context, 'install')).toBe(78)
    expect(f.calls).toEqual([])
    await expect(readFile(f.unit)).rejects.toThrow()
  })
  it('refuses a dollar sign in the node path with exit 78 and writes no unit', async () => {
    await machine.enrollOld()
    const f = fixture()
    if (!f.context.service) throw new Error('fixture')
    f.context.service.node = '/a$b/node'
    expect(await runService(f.context, 'install')).toBe(78)
    expect(machine.output).toContain(
      "the node path contains '$', which systemd cannot run safely; install Node elsewhere",
    )
    expect(f.calls).toEqual([])
    await expect(readFile(f.unit)).rejects.toThrow()
  })
  it('uninstalls idempotently without touching identity, config or provider data', async () => {
    await machine.enrollOld()
    const f = fixture()
    await runService(f.context, 'install')
    f.calls.length = 0
    const config = await readFile(machine.configPath, 'utf8')
    const identity = await machine.store.load()
    const files = await readdir(identityDirectory(machine.configPath))
    expect(await runService(f.context, 'uninstall')).toBe(0)
    expect(await runService(f.context, 'uninstall')).toBe(0)
    expect(f.calls.slice(0, 4).map(({ args }) => args)).toEqual([
      ['--user', 'stop', HOST_UNIT],
      ['--user', 'disable', HOST_UNIT],
      ['--user', 'is-active', '--quiet', HOST_UNIT],
      ['--user', 'daemon-reload'],
    ])
    expect(await readFile(machine.configPath, 'utf8')).toBe(config)
    expect(await machine.store.load()).toEqual(identity)
    expect(await readdir(identityDirectory(machine.configPath))).toEqual(files)
    await expect(readFile(f.unit)).rejects.toThrow()
  })
  it('shows unit state, linger and the same identity summary as status', async () => {
    await machine.enrollOld()
    const f = fixture()
    expect(await runService(f.context, 'status')).toBe(0)
    expect(f.calls.map(({ args }) => args)).toEqual([
      ['--user', 'show', HOST_UNIT, '-p', 'ActiveState,SubState,MainPID,ExecMainStatus'],
      ['show-user', 'testuser', '-p', 'Linger', '--value'],
    ])
    expect(machine.output).toContain('ActiveState=active')
    expect(machine.output).toContain('Linger: on')
    expect(machine.output.join('\n')).toContain('Signed in as "earlier"')
    expect(machine.output.join('\n')).not.toContain('hidden')
  })
  it.each(['daemon-reload', 'enable', 'restart'])(
    'stops installation when %s fails',
    async (failed) => {
      await machine.enrollOld()
      const f = fixture()
      const original = f.context.service?.runner
      if (!original || !f.context.service) throw new Error('fixture')
      f.context.service.runner = async (...args) => {
        const result = await original(...args)
        return args[1].includes(failed) ? { code: 1, stdout: 'private error' } : result
      }
      expect(await runService(f.context, 'install')).toBe(75)
      expect(f.calls.some(({ file }) => file === 'loginctl')).toBe(false)
      expect(machine.output.join('\n')).not.toContain('private error')
    },
  )
  it.each([0, null])(
    'only uninstalls a missing unit when its load-state check succeeds: %s',
    async (code) => {
      const f = fixture()
      const removes: string[] = []
      if (!f.context.service) throw new Error('fixture')
      f.context.service.remove = async (path) => {
        removes.push(path)
      }
      f.context.service.runner = async (_file, args) => ({
        code: args.includes('disable')
          ? 1
          : args.includes('show')
            ? code
            : args.includes('is-active')
              ? 3
              : 0,
        stdout: 'not-found',
      })
      expect(await runService(f.context, 'uninstall')).toBe(code === 0 ? 0 : 75)
      expect(removes).toEqual(code === 0 ? [f.unit] : [])
    },
  )
  it.each(['restart', 'logs', 'status', 'uninstall'] as const)(
    'reports %s runner failures without response details',
    async (action) => {
      const f = fixture()
      if (!f.context.service) throw new Error('fixture')
      f.context.service.runner = async () => ({
        code: null,
        stdout: action === 'logs' ? '' : 'PRIVATE KEY OR SIGNATURE',
      })
      expect(await runService(f.context, action)).toBe(75)
      expect(machine.output.join('\n')).not.toContain('PRIVATE KEY OR SIGNATURE')
    },
  )
  it('refuses unsafe service directory and user without I/O', async () => {
    const f = fixture()
    f.context.env.XDG_CONFIG_HOME = 'relative'
    expect(await runService(f.context, 'uninstall')).toBe(78)
    f.context.env.XDG_CONFIG_HOME = '/safe'
    if (!f.context.service) throw new Error('fixture')
    f.context.service.user = 'user\ncommand'
    expect(await runService(f.context, 'install')).toBe(78)
    expect(f.calls).toEqual([])
  })
  it('restarts and streams journal logs through the runner, with follow only on demand', async () => {
    const f = fixture()
    expect(await runService(f.context, 'restart')).toBe(0)
    expect(await runService(f.context, 'logs')).toBe(0)
    expect(await runService(f.context, 'logs', true)).toBe(0)
    expect(f.calls.map(({ file, args }) => [file, args])).toEqual([
      ['systemctl', ['--user', 'restart', HOST_UNIT]],
      ['journalctl', ['--user', '-u', HOST_UNIT, '-n', '200', '--no-pager']],
      ['journalctl', ['--user', '-u', HOST_UNIT, '-n', '200', '--no-pager', '-f']],
    ])
  })
})

it('logs service writes and execution, never captured environment or child output', async () => {
  const f = fixture()
  await machine.enrollOld()
  const { createHostLog } = await import('../machine/log')
  const log = createHostLog(join(machine.root, 'logs'), [f.context.env.SECRET_TOKEN ?? ''])
  f.context.log = log.write
  for (const action of ['install', 'restart', 'uninstall'] as const)
    expect(await runService(f.context, action)).toBe(0)
  const text = await readFile(join(machine.root, 'logs', 'phosphor.log'), 'utf8')
  expect(text).toContain('unit.written')
  expect(text).toContain('unit.removed')
  expect(text).toContain('"program":"systemctl"')
  expect(text).toContain('"program":"loginctl"')
  expect(text).not.toContain('must-not-appear')
  expect(text).not.toContain('/custom/bin')
  expect(text).not.toContain('secret=hidden')
})

function macFixture() {
  const f = fixture()
  f.context.platform = 'darwin'
  f.context.env.XDG_STATE_HOME = join(machine.root, 'state')
  if (!f.context.service) throw new Error('fixture')
  f.context.service.runner = async (file, args, follow) => {
    f.calls.push({ file, args, follow })
    return {
      code: 0,
      stdout: 'state = running\npid = 123\nlast exit code = 0\nSECRET_TOKEN = hidden',
    }
  }
  return {
    ...f,
    plist: join(machine.root, 'Library', 'LaunchAgents', `${HOST_AGENT}.plist`),
    job: `gui/${f.context.uid}/${HOST_AGENT}`,
  }
}
describe('phosphor service on macOS', () => {
  it('installs with exact argv and pinned PATH, then restarts and uninstalls idempotently', async () => {
    await machine.enrollOld()
    const f = macFixture()
    f.context.env.PATH = '/opt:/custom/bin::/bin:/opt'
    expect(await runService(f.context, 'install')).toBe(0)
    const text = await readFile(f.plist, 'utf8')
    expect(text).toContain('<string>/opt:/custom/bin:/bin</string>')
    expect(text).not.toContain('must-not-appear')
    expect(f.calls.map(({ file, args }) => [file, args])).toEqual([
      ['launchctl', ['bootout', f.job]],
      ['launchctl', ['bootstrap', `gui/${f.context.uid}`, f.plist]],
      ['launchctl', ['kickstart', '-k', f.job]],
    ])
    f.calls.length = 0
    expect(await runService(f.context, 'restart')).toBe(0)
    const config = await readFile(machine.configPath, 'utf8')
    const identity = await machine.store.load()
    expect(await runService(f.context, 'uninstall')).toBe(0)
    expect(await runService(f.context, 'uninstall')).toBe(0)
    expect(f.calls.map(({ args }) => args)).toEqual([
      ['kickstart', '-k', f.job],
      ['bootout', f.job],
      ['bootout', f.job],
    ])
    await expect(readFile(f.plist)).rejects.toThrow()
    expect(await readFile(machine.configPath, 'utf8')).toBe(config)
    expect(await machine.store.load()).toEqual(identity)
  })
  it('requires enrollment and validates directories, uid and XML inputs before calls', async () => {
    const f = macFixture()
    expect(await runService(f.context, 'install')).toBe(69)
    expect(f.calls).toEqual([])
    await machine.enrollOld()
    for (const context of [
      { ...f.context, home: 'relative' },
      { ...f.context, uid: undefined },
      { ...f.context, uid: -1 },
      { ...f.context, service: { ...f.context.service, node: '/node\npath' } },
    ]) {
      expect(await runService(context, 'install')).toBe(78)
      expect(f.calls).toEqual([])
    }
    await expect(readFile(f.plist)).rejects.toThrow()
  })
  it('shows only safe status lines and the permanent failure reason', async () => {
    await machine.enrollOld()
    const f = macFixture()
    await launchdExit(77, f.context.env, machine.root, 1000)
    expect(await runService(f.context, 'status')).toBe(0)
    expect(f.calls.map(({ args }) => args)).toEqual([['print', f.job]])
    expect(machine.output).toContain('state = running')
    expect(machine.output).toContain('pid = 123')
    expect(machine.output).toContain('last exit code = 0')
    expect(machine.output).toContain('Stopped permanently: machine removed')
    expect(machine.output.join('\n')).not.toContain('hidden')
  })
  it.each([3, 1, null])(
    'ignores only missing bootout code %s during install and uninstall',
    async (code) => {
      await machine.enrollOld()
      const f = macFixture()
      if (!f.context.service) throw new Error('fixture')
      const original = f.context.service.runner
      if (!original) throw new Error('fixture')
      f.context.service.runner = async (...args) => {
        const result = await original(...args)
        return args[1][0] === 'bootout' ? { code, stdout: 'private error' } : result
      }
      expect(await runService(f.context, 'install')).toBe(code === 3 ? 0 : 75)
      expect(f.calls.length).toBe(code === 3 ? 3 : 1)
      expect(await runService(f.context, 'uninstall')).toBe(code === 3 ? 0 : 75)
      if (code === 3) expect(await runService(f.context, 'uninstall')).toBe(0)
      if (code !== 3) {
        expect(await readFile(f.plist, 'utf8')).toContain('<plist')
        expect(machine.output).toContain('The service could not be stopped.')
      }
      expect(machine.output.join('\n')).not.toContain('private error')
    },
  )
  it.each(['bootstrap', 'kickstart'] as const)(
    'retains the plist when install %s fails',
    async (command) => {
      await machine.enrollOld()
      for (const code of [1, null]) {
        const f = macFixture()
        if (!f.context.service) throw new Error('fixture')
        f.context.service.runner = async (_file, args) => ({
          code: args[0] === command ? code : 0,
          stdout: 'private error',
        })
        expect(await runService(f.context, 'install')).toBe(75)
        expect(await readFile(f.plist, 'utf8')).toContain('<plist')
        expect(machine.output.join('\n')).toContain('The service could not be installed.')
        expect(machine.output.join('\n')).not.toContain('private error')
      }
    },
  )
  it.each(['status', 'restart'] as const)(
    'reports %s missing jobs and runner failures safely',
    async (action) => {
      for (const code of [113, 1, null]) {
        const f = macFixture()
        if (!f.context.service) throw new Error('fixture')
        f.context.service.runner = async () => ({ code, stdout: 'private error' })
        expect(await runService(f.context, action)).toBe(75)
        expect(machine.output.join('\n')).not.toContain('private error')
        if (action === 'restart' && code === 113)
          expect(machine.output.join('\n')).toContain('Run phosphor setup.')
        if (action === 'status')
          expect(machine.output).toContain('The service state could not be read.')
      }
    },
  )
  it('reads bounded Host and stderr tails and follows only the Host file', async () => {
    const f = macFixture()
    const directory = hostLogDirectory(f.context.env, machine.root)
    await mkdir(directory, { recursive: true })
    const hostLog = join(directory, 'phosphor.log')
    await writeFile(hostLog, Array.from({ length: 300 }, (_, i) => `host ${i}\n`).join(''))
    await writeFile(
      join(directory, 'launchd.err.log'),
      Array.from({ length: 70 }, (_, i) => `err ${i}\n`).join(''),
    )
    expect(await runService(f.context, 'logs')).toBe(0)
    expect(machine.output[0]?.split('\n')).toHaveLength(200)
    expect(machine.output[1]?.split('\n')).toHaveLength(50)
    expect(f.calls).toEqual([])
    expect(await runService(f.context, 'logs', true)).toBe(0)
    expect(f.calls).toEqual([{ file: 'tail', args: ['-c', '+2591', '-F', hostLog], follow: true }])
    if (!f.context.service) throw new Error('fixture')
    f.context.service.runner = async () => ({ code: null, stdout: '' })
    expect(await runService(f.context, 'logs', true)).toBe(75)
  })
  it('reports file failures with exit 75 and ignores only absent optional stderr', async () => {
    const f = macFixture()
    expect(await runService(f.context, 'logs')).toBe(75)
    const directory = hostLogDirectory(f.context.env, machine.root)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'phosphor.log'), 'host')
    expect(await runService(f.context, 'logs')).toBe(0)
    if (!f.context.service) throw new Error('fixture')
    f.context.service.write = async () => {
      throw new Error('private')
    }
    await machine.enrollOld()
    expect(await runService(f.context, 'install')).toBe(75)
    f.context.service.remove = async () => {
      throw new Error('private')
    }
    expect(await runService(f.context, 'uninstall')).toBe(75)
    expect(machine.output.join('\n')).not.toContain('private')
  })
})

it('follows from the read end across intervening growth and starts missing logs at byte 1', async () => {
  const f = macFixture()
  const directory = hostLogDirectory(f.context.env, machine.root)
  await mkdir(directory, { recursive: true })
  const hostLog = join(directory, 'phosphor.log')
  await writeFile(hostLog, 'first\n')
  // The stderr print falls between the Host read and the follow invocation.
  await writeFile(join(directory, 'launchd.err.log'), 'stderr')
  f.context.print = (line) => {
    machine.output.push(line)
    if (line === 'stderr') writeFileSync(hostLog, 'first\nappended\n')
  }
  if (!f.context.service) throw new Error('fixture')
  f.context.service.runner = async (file, args, follow) => {
    f.calls.push({ file, args, follow })
    const text = await readFile(hostLog, 'utf8')
    const offset = args[1]
    // Simulate tail's +byte start, not a fresh seek to EOF.
    if (args[0] !== '-c' || offset !== '+7') throw new Error('lost read-to-follow bytes')
    expect(text.slice(Number(offset.slice(1)) - 1)).toBe('appended\n')
    return { code: 0, stdout: '' }
  }
  expect(await runService(f.context, 'logs', true)).toBe(0)
  expect(f.calls).toEqual([{ file: 'tail', args: ['-c', '+7', '-F', hostLog], follow: true }])
  const { unlink } = await import('node:fs/promises')
  await unlink(hostLog)
  f.calls.length = 0
  f.context.print = () => {}
  f.context.service.runner = async (file, args, follow) => {
    f.calls.push({ file, args, follow })
    return { code: 0, stdout: '' }
  }
  expect(await runService(f.context, 'logs', true)).toBe(0)
  expect(f.calls).toEqual([{ file: 'tail', args: ['-c', '+1', '-F', hostLog], follow: true }])
})
