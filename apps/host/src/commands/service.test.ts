import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { controlMachine, type ControlMachine } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { HOST_UNIT, type ServiceRunner } from '../machine/systemd'
import { runService, type ServiceContext } from './service'
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
      code: 0,
      stdout: args.includes('show')
        ? 'ActiveState=active\nSubState=running\nMainPID=123\nExecMainStatus=0\nsecret=hidden'
        : 'yes',
    }
  }
  const context: ServiceContext = {
    ...machine.context,
    home: machine.root,
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
    expect(text).toContain('Environment="PATH=/custom/bin:/bin"')
    expect(text).toContain('"/opt/node path" "/opt/phosphor.mjs" "run" "--config"')
    expect(text).not.toContain('must-not-appear')
    expect(f.calls.map(({ file, args }) => [file, args])).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', HOST_UNIT]],
      ['systemctl', ['--user', 'restart', HOST_UNIT]],
      ['loginctl', ['enable-linger', 'testuser']],
    ])
    expect(await runService(f.context, 'install')).toBe(0)
    expect(await readFile(f.unit, 'utf8')).toBe(text)
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
  it('requires enrollment and refuses non-Linux without any service calls', async () => {
    const f = fixture()
    expect(await runService(f.context, 'install')).toBe(69)
    for (const action of ['install', 'status', 'restart', 'logs', 'uninstall'] as const)
      expect(await runService({ ...f.context, platform: 'darwin' }, action)).toBe(69)
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
    expect(f.calls.slice(0, 2).map(({ args }) => args)).toEqual([
      ['--user', 'disable', '--now', HOST_UNIT],
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
        code: args.includes('disable') ? 1 : args.includes('show') ? code : 0,
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
